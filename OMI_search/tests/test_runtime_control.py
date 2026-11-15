"""Offline adapter guards and catalog parity; all Launcher IO mocked."""
from hashlib import sha256
import ast
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import launcher_transport
from runtime_control_fixture import load_source, runtime_status_body, runtime_receipt_body

REQUEST_ID = "26f0796d-bda1-49d3-afda-a4f1fb565ac8"
OWNER_ID = "8e7a874d-e3be-4c35-af35-3b796c606b3b"
ARGS = {"request_id": REQUEST_ID, "expected_owner_id": OWNER_ID, "confirmation": "restart_backend"}
TOKEN = "0123456789abcdef" * 4  # Synthetic fixture only.
MUTATIONS = {
    "omi_restart_backend": ("RestartBackend", "restart_backend"),
    "omi_start_backend": ("StartBackend", "start_backend"),
    "omi_recover_failed_start": ("RecoverFailedStart", "recover_failed_start"),
    "omi_upgrade_db_schema": ("SchemaUpgrade", "upgrade_schema"),
}
NAMES = {"omi_read_runtime_status", "omi_read_runtime_operation", *MUTATIONS}


class RuntimeControlTests(unittest.TestCase):
    def setUp(self):
        self.core = load_source()
        self.ns = self.core._call_tool.__globals__
        self.pipe = Mock()
        self.network = Mock(side_effect=AssertionError("Runtime must not use HTTP"))
        for scope in (
            patch.object(launcher_transport, "request", self.pipe),
            patch.dict(self.ns, urlopen=self.network, API_BASE_URL="http://127.0.0.1:8400",
                       AI_TRUST_TOKEN="synthetic-ai-token"),
            patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": TOKEN}),
        ):
            scope.start()
            self.addCleanup(scope.stop)

    def call(self, name="omi_restart_backend", args=None):
        return self.core._call_tool(name, dict(ARGS) if args is None else args)

    def test_fixed_wire_and_readers_without_credential_or_backend(self):
        cases = [("omi_read_runtime_status", {}, "Status", runtime_status_body(OWNER_ID)),
                 ("omi_read_runtime_operation", {"request_id": REQUEST_ID}, "ReadOperation",
                  runtime_receipt_body(REQUEST_ID, OWNER_ID, "unknown"))]
        with patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": ""}), \
                patch.dict(self.ns, API_BASE_URL="http://backend-unavailable.invalid"):
            for name, args, action, body in cases:
                self.pipe.reset_mock()
                self.pipe.return_value = body
                self.assertEqual(self.call(name, args), {"transport_status": "pipe_response", "response": body})
                self.pipe.assert_called_once_with({"action": action, "request_id": args.get("request_id", ""),
                                                   "expected_owner_id": "", "token": ""})
        self.network.assert_not_called()

    def test_restart_fixed_grammar_and_receipt_states_no_retry(self):
        for state in ("accepted", "running", "succeeded", "failed", "blocked", "unknown"):
            body = {"schema": launcher_transport.SCHEMA, "request_id": REQUEST_ID, "state": state,
                    "future": [None, False, 0], "owner_id": OWNER_ID}
            self.pipe.reset_mock()
            self.pipe.return_value = body
            result = self.call()
            self.assertEqual(result, {"transport_status": "pipe_response", "response": body})
            self.pipe.assert_called_once_with({"action": "RestartBackend", "request_id": REQUEST_ID,
                                               "expected_owner_id": OWNER_ID, "token": TOKEN})
            self.assertNotIn(TOKEN, json.dumps(result))
        self.network.assert_not_called()

    def test_forbidden_response_remains_authoritative(self):
        body = {"schema": launcher_transport.SCHEMA, "error": "RUNTIME_CONTROL_FORBIDDEN"}
        self.pipe.return_value = body
        self.assertEqual(self.call()["response"], body)
        body = {"schema": launcher_transport.SCHEMA, "state": "unknown", "reason": "STORE_UNAVAILABLE"}
        self.pipe.return_value = body
        self.assertEqual(self.call()["response"], body)

    def test_pre_send_denial_and_post_send_unknown_are_distinct(self):
        for sent in (False, True):
            for code in ("RUNTIME_TIMEOUT", "RUNTIME_OWNER_CHANGED", "RUNTIME_PIPE_ACCESS_DENIED"):
                self.pipe.reset_mock()
                self.pipe.side_effect = launcher_transport.PipeError(code, sent=sent)
                with self.assertRaises(self.core.RuntimeControlError) as caught:
                    self.call()
                expected = {"error": code, "transport_status": "error", "request_id": REQUEST_ID}
                if sent:
                    expected.update(outcome="unknown", next_action="read_runtime_operation_same_request_id")
                self.assertEqual(caught.exception.payload, expected)
                self.pipe.assert_called_once()
        self.network.assert_not_called()

    def test_unknown_then_same_uuid_read_has_no_mutation_fallback(self):
        self.pipe.side_effect = launcher_transport.PipeError("RUNTIME_TIMEOUT", sent=True)
        with self.assertRaises(self.core.RuntimeControlError):
            self.call()
        self.pipe.side_effect = None
        body = runtime_receipt_body(REQUEST_ID, OWNER_ID, "unknown")
        self.pipe.return_value = body
        self.assertEqual(self.call("omi_read_runtime_operation", {"request_id": REQUEST_ID})["response"], body)
        self.assertEqual([c.args[0]["action"] for c in self.pipe.call_args_list], ["RestartBackend", "ReadOperation"])
        self.assertTrue(all(c.args[0]["request_id"] == REQUEST_ID for c in self.pipe.call_args_list))

    def test_echo_or_wrong_receipt_fails_closed(self):
        for body, code in (({"nested": [TOKEN]}, "RUNTIME_RESPONSE_REDACTED"),
                           ({TOKEN: "key"}, "RUNTIME_RESPONSE_REDACTED"),
                           ({"request_id": OWNER_ID}, "INVALID_RUNTIME_RESPONSE")):
            self.pipe.return_value = body
            with self.assertRaises(self.core.RuntimeControlError) as caught:
                self.call()
            self.assertEqual(str(caught.exception), code)
            self.assertEqual(caught.exception.payload["outcome"], "unknown")
            self.assertNotIn(TOKEN, json.dumps(caught.exception.payload))

    def test_uuid_canonicalization_does_not_change_identity(self):
        self.pipe.return_value = runtime_receipt_body(REQUEST_ID, OWNER_ID, "unknown")
        self.call(args={**ARGS, "request_id": REQUEST_ID.upper(), "expected_owner_id": OWNER_ID.upper()})
        self.assertEqual(self.pipe.call_args.args[0]["request_id"], REQUEST_ID)
        self.assertEqual(self.pipe.call_args.args[0]["expected_owner_id"], OWNER_ID)

    def test_only_fixed_actions_no_http_shell_or_local_actor(self):
        root = Path(__file__).resolve().parents[1]
        tree = ast.parse((root / "server.py").read_text(encoding="utf-8"))
        functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        relay = functions["_call_runtime_tool"]
        actions = [n.args[0].value if isinstance(n.args[0], ast.Constant) else ast.unparse(n.args[0]) for n in ast.walk(relay) if isinstance(n, ast.Call)
                   and isinstance(n.func, ast.Name) and n.func.id == "_runtime_request"]
        self.assertEqual(actions, ["action", "Status", "ReadOperation"])
        self.assertEqual(self.core.RUNTIME_MUTATIONS, MUTATIONS)
        calls = {ast.unparse(n.func) for f in (relay, functions["_runtime_request"])
                 for n in ast.walk(f) if isinstance(n, ast.Call)}
        self.assertFalse(calls & {"urlopen", "build_opener", "_api_request", "subprocess.Popen", "os.system"})
        source = (root / "launcher_transport.py").read_text(encoding="utf-8")
        self.assertNotIn("launcher_local_operator", source)
        self.assertNotIn("subprocess", source)
        self.assertNotIn("OMI_RUNTIME_LAUNCHER_PID", source)
        self.assertNotIn("os.environ", source)
        self.assertNotIn(".env", source)
    def test_online_and_offline_catalogs_add_exactly_six_tools(self):
        online = {"tools": [self.core._fallback_ask_source(), self.core._fallback_refresh_status_source()]}
        for kwargs in ({"return_value": online}, {"side_effect": RuntimeError("offline")}):
            with patch.dict(self.ns, _api_request=Mock(**kwargs)):
                catalog = self.core._tools_for_client()
            self.assertEqual(len(catalog), 63)
            self.assertEqual({t["name"] for t in catalog[20:26]}, NAMES)
            self.assertEqual(len({t["name"] for t in catalog}), 63)
            self.assertNotIn("omi.search", {t["name"] for t in catalog})

    def test_original_seventeen_schemas_and_resources_byte_equivalent(self):
        # 2026-10-26: verified against pre-task HEAD (server.py was clean).
        for value, digest in (
            (self.core.PUBLIC_TOOLS[:17], "d95da68a676740190cd01926db14c7080be3fc49c295d2022f4adade7f476904"),
            (self.core._tw_dashboard_resources_for_client()[:2], "f6949b0fdc4af73ee2e97a139213462974a4e7e5b0dd709331c2aa3a186d6278"),
        ):
            self.assertEqual(sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest(), digest)

    def test_narrow_schema_and_disruptive_annotations(self):
        tools = {t["name"]: t for t in self.core.PUBLIC_TOOLS if t["name"] in NAMES}
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

    def test_missing_token_fails_closed_without_ai_token_fallback(self):
        with patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": ""}):
            with self.assertRaisesRegex(self.core.RuntimeControlError, "TOKEN_MISSING_OR_INVALID"):
                self.call()
        self.pipe.assert_not_called()

    def test_invalid_token_is_never_logged_or_sent(self):
        for token in ("synthetic-runtime-test-credential", "a" * 63, "a" * 65,
                      "A" * 64, "g" * 64, " " + TOKEN, TOKEN + "\n", "é" * 64):
            with self.subTest(length=len(token)), patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": token}):
                with self.assertRaises(self.core.RuntimeControlError) as caught:
                    self.call()
            self.assertEqual(str(caught.exception), "RUNTIME_CONTROL_TOKEN_MISSING_OR_INVALID")
            self.assertNotIn(token, json.dumps(caught.exception.payload))
        self.pipe.assert_not_called()

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
        self.pipe.assert_not_called()

    def test_bad_confirmation_never_sends(self):
        for value in (True, "yes", "RESTART_BACKEND", " restart_backend", None):
            with self.subTest(value=value), self.assertRaisesRegex(self.core.RuntimeControlError, "CONFIRMATION"):
                self.call(args={**ARGS, "confirmation": value})
        self.pipe.assert_not_called()

    def test_all_mutations_fixed_wire_and_terminal_states(self):
        for name, (action, confirmation) in MUTATIONS.items():
            for state in ('accepted', 'running', 'succeeded', 'blocked', 'failed', 'unknown'):
                with self.subTest(tool=name, state=state):
                    self.pipe.reset_mock()
                    body = {'schema': launcher_transport.SCHEMA, 'request_id': REQUEST_ID, 'action': action,
                            'state': state, 'after': None, 'opaque_future': [False, 0, None]}
                    self.pipe.return_value = body
                    self.assertEqual(self.call(name, {**ARGS, 'confirmation': confirmation})['response'], body)
                    wire = {'action': action, 'request_id': REQUEST_ID, 'expected_owner_id': OWNER_ID, 'token': TOKEN}
                    if action != 'RestartBackend':
                        wire['confirmation'] = confirmation
                    self.pipe.assert_called_once_with(wire)
        self.network.assert_not_called()

    def test_all_mutations_reject_wrong_literals_paths_actor_uuid_and_missing_token(self):
        for name, (_, confirmation) in MUTATIONS.items():
            args = {**ARGS, 'confirmation': confirmation}
            cases = [{**args, key: 'injected'} for key in (
                'request_id', 'expected_owner_id', 'confirmation', 'actor', 'shell', 'database_path',
                'schema_lock_path', 'approved', 'token', 'backend_preflight')]
            cases += [{k: v for k, v in args.items() if k != missing} for missing in args]
            for invalid in cases:
                with self.subTest(tool=name, keys=list(invalid)), self.assertRaises(self.core.RuntimeControlError):
                    self.call(name, invalid)
            with patch.dict(os.environ, {'OMI_SEARCH_RUNTIME_CONTROL_TOKEN': ''}), \
                    self.assertRaisesRegex(self.core.RuntimeControlError, 'TOKEN_MISSING_OR_INVALID'):
                self.call(name, args)
        self.pipe.assert_not_called()

    def test_all_mutations_timeout_unknown_then_read_only_same_uuid(self):
        for name, (_, confirmation) in MUTATIONS.items():
            self.pipe.reset_mock()
            self.pipe.side_effect = launcher_transport.PipeError('RUNTIME_TIMEOUT', sent=True)
            with self.assertRaises(self.core.RuntimeControlError) as caught:
                self.call(name, {**ARGS, 'confirmation': confirmation})
            self.assertEqual(caught.exception.payload['outcome'], 'unknown')
            self.pipe.assert_called_once()
            self.pipe.side_effect = None
            body = {'schema': launcher_transport.SCHEMA, 'request_id': REQUEST_ID, 'state': 'unknown', 'reason': 'NOT_FOUND'}
            self.pipe.return_value = body
            self.assertEqual(self.call('omi_read_runtime_operation', {'request_id': REQUEST_ID})['response'], body)
            self.assertEqual(len(self.pipe.call_args_list), 2)
            self.assertEqual(self.pipe.call_args.args[0]['action'], 'ReadOperation')
            self.assertEqual(self.pipe.call_args.args[0]['token'], '')

    def test_all_mutations_annotations_and_no_local_approval_instructions(self):
        tools = {t['name']: t for t in self.core.PUBLIC_TOOLS}
        for name, (_, literal) in MUTATIONS.items():
            tool = tools[name]
            self.assertEqual(set(tool['inputSchema']['properties']), set(ARGS))
            self.assertEqual(tool['inputSchema']['properties']['confirmation'], {'type': 'string', 'const': literal})
            self.assertFalse(tool['annotations']['readOnlyHint'])
            self.assertTrue(tool['annotations']['destructiveHint'])
            self.assertIn('No local Windows human approval', tool['description'])
            self.assertIn('explicit chat user intent', tool['description'])
        self.assertIn('dedicated token and OS-pinned same-user Launcher', self.core.SERVER_INSTRUCTIONS)

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
        self.pipe.assert_not_called()
