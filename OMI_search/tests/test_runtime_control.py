"""Mock-only source tests; no socket, service, database, provider or SDK import."""
from contextlib import redirect_stderr, redirect_stdout
from hashlib import sha256
import ast
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

from runtime_control_fixture import load_source

REQUEST_ID = "26f0796d-bda1-49d3-afda-a4f1fb565ac8"
OWNER_ID = "8e7a874d-e3be-4c35-af35-3b796c606b3b"
ARGS = {"request_id": REQUEST_ID, "expected_owner_id": OWNER_ID, "confirmation": "restart_backend"}
# Synthetic credential only; backend fixture stores its SHA256, never the plaintext.
TOKEN = "0123456789abcdef" * 4
TOKEN_SHA256 = sha256(TOKEN.encode("ascii")).hexdigest()
NAMES = {"omi_read_runtime_status", "omi_restart_backend", "omi_read_runtime_operation"}


def response(body, code=200):
    stream = io.BytesIO(json.dumps(body).encode())
    stream.code = code
    return stream


class RuntimeControlTests(unittest.TestCase):
    def setUp(self):
        self.core = load_source()
        self.ns = self.core._call_tool.__globals__
        self.opener = Mock()
        self.factory = Mock(return_value=self.opener)
        self.network = Mock(side_effect=AssertionError("Unexpected market network request"))
        self.scope = patch.dict(self.ns, build_opener=self.factory, urlopen=self.network,
                                API_BASE_URL="http://127.0.0.1:8400", AI_TRUST_TOKEN="synthetic-ai-token")
        self.scope.start()
        self.addCleanup(self.scope.stop)
        self.env = patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": TOKEN})
        self.env.start()
        self.addCleanup(self.env.stop)

    def call(self, name="omi_restart_backend", args=None):
        return self.core._call_tool(name, dict(ARGS) if args is None else args)

    def test_online_and_offline_catalogs_add_exactly_three_tools(self):
        online = {"tools": [self.core._fallback_ask_source(), self.core._fallback_refresh_status_source()]}
        for kwargs in ({"return_value": online}, {"side_effect": RuntimeError("offline")}):
            with patch.dict(self.ns, _api_request=Mock(**kwargs)):
                catalog = self.core._tools_for_client()
            self.assertEqual(len(catalog), 20)
            self.assertEqual({t["name"] for t in catalog[-3:]}, NAMES)
            self.assertEqual(len({t["name"] for t in catalog}), 20)
            self.assertNotIn("omi.search", {t["name"] for t in catalog})

    def test_original_seventeen_schemas_and_resources_byte_equivalent(self):
        # Digests captured from the DIRTY pre-task source, not Git HEAD.
        for value, digest in (
            (self.core.PUBLIC_TOOLS[:17], "bd0cd2ccf046b9025586b8da6eb46b257c1cbf0d7152997f63969b2d4df8d85c"),
            (self.core._tw_dashboard_resources_for_client(), "f6949b0fdc4af73ee2e97a139213462974a4e7e5b0dd709331c2aa3a186d6278"),
        ):
            self.assertEqual(sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest(), digest)

    def test_narrow_schema_and_disruptive_annotations(self):
        tools = {t["name"]: t for t in self.core.PUBLIC_TOOLS[-3:]}
        restart = tools["omi_restart_backend"]
        self.assertEqual(set(restart["inputSchema"]["required"]), set(ARGS))
        self.assertEqual(set(restart["inputSchema"]["properties"]), set(ARGS))
        self.assertFalse(restart["annotations"]["readOnlyHint"])
        self.assertTrue(restart["annotations"]["destructiveHint"])
        self.assertTrue(restart["_meta"]["omi/runtime-control/disruptive"])
        for tool in tools.values():
            self.assertFalse(tool["inputSchema"]["additionalProperties"])
            self.assertNotIn("ui", tool.get("_meta", {}))
        self.assertNotIn(TOKEN, json.dumps(tools))

    def test_status_fixed_get_preserves_identity_and_unknown_fields(self):
        body = {"version": "omi.runtime-control.v1", "identity": "unknown", "launcher_instance_id": OWNER_ID,
                "backend": {}, "frontend": {}, "launcher": {}, "mcp": {}, "future": [None, False, "keep"]}
        self.opener.open.return_value = response(body)
        actual = self.call("omi_read_runtime_status", {})
        self.assertEqual(actual, {"transport_status": "http_response", "http_status": 200, "response": body})
        req = self.opener.open.call_args.args[0]
        self.assertEqual(req.full_url, "http://127.0.0.1:8400/api/system/runtime-control/status")
        self.assertEqual(req.method, "GET")
        self.assertIsNone(req.data)
        self.assertFalse(any("token" in name.lower() for name in req.headers))
        self.network.assert_not_called()

    def test_missing_token_fails_closed_without_ai_token_fallback(self):
        with patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": ""}):
            with self.assertRaisesRegex(self.core.RuntimeControlError, "TOKEN_MISSING_OR_INVALID"):
                self.call()
        self.factory.assert_not_called()

    def test_invalid_token_is_never_logged_or_sent(self):
        for token in ("synthetic-runtime-test-credential", "a" * 63, "a" * 65,
                      "A" * 64, "g" * 64, " " + TOKEN, TOKEN + "\n", "é" * 64):
            with self.subTest(length=len(token)), patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": token}):
                with self.assertRaises(self.core.RuntimeControlError) as caught:
                    self.call()
            self.assertEqual(str(caught.exception), "RUNTIME_CONTROL_TOKEN_MISSING_OR_INVALID")
            self.assertNotIn(token, json.dumps(caught.exception.payload))
        self.factory.assert_not_called()

    def test_restart_fixture_matches_backend_sha256_configuration(self):
        # Mock backend boundary: valid-format tokens still need the paired backend hash.
        backend_config = {"OMI_RUNTIME_CONTROL_TOKEN_SHA256": TOKEN_SHA256}

        def backend(request, *, timeout):
            credential = request.get_header("X-omi-runtime-control-token")
            self.assertRegex(credential, r"^[0-9a-f]{64}$")
            authorized = sha256(credential.encode("ascii")).hexdigest() == backend_config["OMI_RUNTIME_CONTROL_TOKEN_SHA256"]
            if not authorized:
                raise HTTPError("http://fixture", 403, "unauthorized", {}, response({"status": "unauthorized"}))
            return response({"request_id": REQUEST_ID, "status": "accepted"}, 202)

        self.opener.open.side_effect = backend
        self.assertEqual(self.call()["http_status"], 202)
        with patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": "f" * 64}):
            denied = self.call()
        self.assertEqual(denied["http_status"], 403)
        self.assertEqual(denied["response"]["status"], "unauthorized")
        self.assertEqual(self.opener.open.call_count, 2)

    def test_invalid_uuids_and_missing_or_extra_arguments_never_send(self):
        for key in ("request_id", "expected_owner_id"):
            for value in (None, 1, "", "../status", "?command=stop", REQUEST_ID.replace("-", ""), "{" + REQUEST_ID + "}"):
                with self.subTest(key=key, value=value), self.assertRaises(self.core.RuntimeControlError):
                    self.call(args={**ARGS, key: value})
        for args in ({}, {**ARGS, "token": "caller-secret"}, {**ARGS, "command": "stop"}):
            with self.assertRaises(self.core.RuntimeControlError):
                self.call(args=args)
        for key in ("url", "path", "method", "pid", "pipe", "shell", "backend_preflight", "owner_approval"):
            with self.subTest(extra=key), self.assertRaises(self.core.RuntimeControlError):
                self.call(args={**ARGS, key: "caller-controlled"})
        with self.assertRaises(self.core.RuntimeControlError):
            self.call("omi_read_runtime_status", {"refresh": True})
        with self.assertRaises(self.core.RuntimeControlError):
            self.call("omi_read_runtime_operation", {"request_id": "../../stop"})
        self.factory.assert_not_called()

    def test_runtime_source_keeps_fixed_routes_and_unprojected_body(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / "server.py").read_text(encoding="utf-8"))
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        relay = functions["_call_runtime_tool"]
        requests = [node for node in ast.walk(relay) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name) and node.func.id == "_runtime_request"]
        routes = {(ast.literal_eval(node.args[0]), ast.unparse(node.args[1])) for node in requests}
        self.assertEqual(routes, {
            ("GET", "'/api/system/runtime-control/status'"),
            ("GET", "f'/api/system/runtime-control/operations/{request_id}'"),
            ("POST", "'/api/system/runtime-control/restart-backend'"),
        })
        self.assertEqual(len(requests), 3)
        transport = functions["_runtime_request"]
        returned = [node.value for node in ast.walk(transport) if isinstance(node, ast.Return)]
        self.assertEqual(len(returned), 1)
        self.assertEqual(ast.unparse(returned[0]),
                         "{'transport_status': 'http_response', 'http_status': status, 'response': body}")
        # Runtime forwarding cannot acquire process/pipe/shell or writer authority.
        for function in (relay, transport):
            calls = {ast.unparse(node.func) for node in ast.walk(function) if isinstance(node, ast.Call)}
            self.assertFalse(calls & {"open", "eval", "exec", "__import__", "os.system", "os.kill",
                                     "os.popen", "subprocess.run", "subprocess.Popen"})
            for node in ast.walk(function):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    self.assertNotIn(node.value, {"writer_preflight", "all_writers_drained", "owner_approval"})

    def test_bad_confirmation_never_sends(self):
        for value in (True, "yes", "RESTART_BACKEND", " restart_backend", None):
            with self.subTest(value=value), self.assertRaisesRegex(self.core.RuntimeControlError, "CONFIRMATION"):
                self.call(args={**ARGS, "confirmation": value})
        self.factory.assert_not_called()

    def test_accepted_202_exact_post_body_dedicated_header_no_retry(self):
        body = {"request_id": REQUEST_ID, "status": "accepted", "queue": "durable"}
        self.opener.open.return_value = response(body, 202)
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            result = self.core._tool_result(self.call())
        req = self.opener.open.call_args.args[0]
        self.assertEqual(req.full_url, "http://127.0.0.1:8400/api/system/runtime-control/restart-backend")
        self.assertEqual(req.method, "POST")
        self.assertEqual(json.loads(req.data), ARGS)
        self.assertEqual(req.get_header("X-omi-runtime-control-token"), TOKEN)
        self.assertIsNone(req.get_header("X-omi-ai-trust-token"))
        self.assertEqual(result["structuredContent"]["response"], body)
        self.assertEqual(result["structuredContent"]["http_status"], 202)
        self.assertNotIn("succeeded", json.dumps(result))
        self.assertNotIn(TOKEN, json.dumps(result) + output.getvalue())
        self.opener.open.assert_called_once()
        self.network.assert_not_called()

    def test_http_denied_blocked_unavailable_preserve_authoritative_body(self):
        for code, state in ((403, "unauthorized"), (409, "blocked"), (503, "unavailable")):
            body = {"status": state, "reason": "writer_drain_false", "request_id": REQUEST_ID}
            self.opener.open.side_effect = HTTPError("http://fixture", code, TOKEN, {}, response(body))
            result = self.call()
            self.assertEqual(result["http_status"], code)
            self.assertEqual(result["response"], body)
            self.assertNotIn(TOKEN, json.dumps(result))
        self.assertEqual(self.opener.open.call_count, 3)

    def test_timeout_and_network_failure_are_distinct_unknown_not_retried(self):
        for error, code in ((TimeoutError(TOKEN), "RUNTIME_TIMEOUT"), (URLError(TimeoutError(TOKEN)), "RUNTIME_TIMEOUT"),
                            (URLError(TOKEN), "RUNTIME_UNAVAILABLE"), (ConnectionResetError(TOKEN), "RUNTIME_UNAVAILABLE")):
            self.opener.open.reset_mock()
            self.opener.open.side_effect = error
            with self.assertRaises(self.core.RuntimeControlError) as caught:
                self.call()
            self.assertEqual(caught.exception.payload, {"error": code, "transport_status": "error", "request_id": REQUEST_ID,
                             "outcome": "unknown", "next_action": "read_runtime_operation_same_request_id"})
            self.opener.open.assert_called_once()
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_status_transport_failure_does_not_invent_backend_state(self):
        self.opener.open.side_effect = URLError(TOKEN)
        with self.assertRaises(self.core.RuntimeControlError) as caught:
            self.call("omi_read_runtime_status", {})
        self.assertEqual(caught.exception.payload, {"error": "RUNTIME_UNAVAILABLE", "transport_status": "error"})

    def test_receipt_states_are_unchanged_and_get_works_without_token(self):
        with patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": ""}):
            for state in ("accepted", "running", "succeeded", "failed", "blocked", "unknown"):
                body = {"request_id": REQUEST_ID, "status": state}
                self.opener.open.return_value = response(body)
                self.assertEqual(self.call("omi_read_runtime_operation", {"request_id": REQUEST_ID})["response"], body)
                req = self.opener.open.call_args.args[0]
                self.assertEqual(req.method, "GET")
                self.assertEqual(req.full_url, f"http://127.0.0.1:8400/api/system/runtime-control/operations/{REQUEST_ID}")
                self.assertIsNone(req.data)

    def test_malformed_or_secret_echo_response_fails_closed(self):
        for raw, code in ((b"not JSON", "INVALID_RUNTIME_RESPONSE"), (b"[]", "INVALID_RUNTIME_RESPONSE"),
                          (b'{"value":NaN}', "INVALID_RUNTIME_RESPONSE"),
                          (json.dumps({"nested": [TOKEN]}).encode(), "RUNTIME_RESPONSE_REDACTED"),
                          (json.dumps({TOKEN: "key"}).encode(), "RUNTIME_RESPONSE_REDACTED")):
            stream = io.BytesIO(raw)
            stream.code = 202
            self.opener.open.return_value = stream
            with self.assertRaises(self.core.RuntimeControlError) as caught:
                self.call()
            self.assertEqual(str(caught.exception), code)
            self.assertEqual(caught.exception.payload["outcome"], "unknown")
            self.assertNotIn(TOKEN, json.dumps(caught.exception.payload))

    def test_management_token_never_follows_redirect_or_proxy(self):
        self.opener.open.return_value = response({"status": "accepted"}, 202)
        self.call()
        proxy, redirect = self.factory.call_args.args
        self.assertEqual(proxy.proxies, {})
        for code in (301, 302, 303, 307, 308):
            self.assertIsNone(redirect.redirect_request(Request("http://localhost"), None, code, "", {}, "http://elsewhere"))

    def test_nonlocal_or_credentialed_backend_base_fails_before_send(self):
        for base in ("http://example.com", "http://user:pass@localhost", "http://localhost/api", "http://localhost?x=1", "file:///test"):
            with patch.dict(self.ns, API_BASE_URL=base), self.assertRaisesRegex(self.core.RuntimeControlError, "BACKEND_URL"):
                self.call()
        self.factory.assert_not_called()

    def test_ask_legacy_and_dashboard_still_use_original_transport(self):
        envelope = {"contract_version": "omi.decision.v4", "status": "TARGET_NOT_FOUND"}
        post = Mock(return_value=envelope)
        with patch.dict(self.ns, _api_post=post):
            for name, args in (("omi_ask", {"question": "unaltered", "allow_write": True, "allow_llm": True}),
                               ("omi.search", {"query": "unaltered", "stock_id": "2330"})):
                self.assertEqual(self.call(name, args), envelope)
                payload = post.call_args.args[1]
                self.assertEqual(payload["question"], "unaltered")
                self.assertFalse(payload["allow_write"])
                self.assertFalse(payload["allow_llm"])
                self.assertFalse(payload["allow_external_fetch"])
        body = {"kind": "omi.tw_market_dashboard", "version": "omi.tw_market_dashboard.v1"}
        upstream = Mock(return_value=body)
        with patch.dict(self.ns, _api_request=upstream):
            self.assertEqual(self.call("omi_read_tw_market_dashboard", {}), body)
        self.factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
