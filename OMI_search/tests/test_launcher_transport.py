"""Real disposable Windows pipes, no live OMI/HTTP/credential IO.

Only the compile-time repository pin is patched to the temporary fixture root.
PID, creation, OS image, argv and user checks execute against real OS handles.
"""
from contextlib import contextmanager, ExitStack
from hashlib import sha256
import ctypes
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from uuid import uuid4
from unittest.mock import patch

import launcher_transport as transport
from runtime_control_fixture import load_source
from test_runtime_control import ARGS, REQUEST_ID, OWNER_ID


@unittest.skipUnless(os.name == "nt", "Windows pipe fixture requires Windows")
class LauncherPipeTests(unittest.TestCase):
    @contextmanager
    def fixture(self, body=None, *, mode="reply", raw=None, wrong_script=False, binding="absent"):
        with tempfile.TemporaryDirectory(prefix="omi-adapter-pipe-") as folder, ExitStack() as scopes:
            root = Path(folder)
            scripts = root / "scripts"
            scripts.mkdir()
            path = scripts / ("wrong-launcher.ps1" if wrong_script else "omi-launcher.ps1")
            path.write_bytes(Path(__file__).with_name("launcher_pipe_fixture.ps1").read_bytes())
            suffix = sha256(str(root).lower().encode()).hexdigest()[:24]
            # Assert separation before any process or pipe can be created.
            self.assertNotEqual(suffix, sha256(transport.REPO_ROOT.lower().encode()).hexdigest()[:24])
            config = {"pipe": "omi-runtime-" + suffix, "mode": mode, "binding": binding, "client_pid": os.getpid(),
                      "raw": raw if raw is not None else json.dumps(body or {"schema": transport.SCHEMA, "owner_id": OWNER_ID}) + "\n"}
            (root / "fixture.json").write_text(json.dumps(config), encoding="utf-8")
            if mode == "controller_snapshot":
                for name in ("OmiRuntimeControl.cs", "OmiOwnedShutdown.cs"):
                    source = Path(transport.REPO_ROOT) / "scripts" / name
                    snapshot = source.read_bytes()
                    (root / name).write_bytes(snapshot)
                    # Source drift is visible; never overwrite the main job.
                    self.assertEqual(source.read_bytes(), snapshot)
                    print("Controller fixture source: " + name + " SHA256=" + sha256(snapshot).hexdigest())
            executable = transport._Windows().system_executable()
            # Whitelist child environment; do not read/copy the parent secret env.
            system_root = str(Path(executable).parents[3])
            child_env = {"SystemRoot": system_root, "WINDIR": system_root, "TEMP": folder, "TMP": folder,
                         "PATH": str(Path(system_root) / "System32")}
            child = subprocess.Popen([executable, "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA",
                                      "-WindowStyle", "Hidden", "-File", str(path)],
                                     env=child_env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                deadline = time.monotonic() + 10
                while not (root / "ready").exists():
                    if child.poll() is not None or time.monotonic() > deadline:
                        self.fail("Disposable pipe fixture failed to become ready")
                    time.sleep(.025)
                scopes.enter_context(patch.object(transport, "REPO_ROOT", str(root)))
                scopes.enter_context(patch.object(socket, "create_connection", side_effect=AssertionError("HTTP forbidden")))
                yield root
            finally:
                (root / "stop").touch()
                child.wait(timeout=5)  # Cooperative fixture exit only; no kill.
                self.assertIn(child.returncode, (0, 2))  # Broken pipe on pre-send denial is expected.

    def message(self, action="Status"):
        mutation = action in transport.ACTION_CONFIRMATIONS
        body = {"action": action, "request_id": "" if action == "Status" else REQUEST_ID,
                "expected_owner_id": OWNER_ID if mutation else "",
                "token": "a" * 64 if mutation else ""}
        if mutation and action != "RestartBackend":
            body["confirmation"] = transport.ACTION_CONFIRMATIONS[action]
        return body

    def test_status_and_receipt_without_backend_or_token(self):
        core = load_source()
        for name, args, body in (
            ("omi_read_runtime_status", {}, {"schema": transport.SCHEMA, "owner_id": OWNER_ID,
                                           "backend": {"status": "stopped"}}),
            ("omi_read_runtime_operation", {"request_id": REQUEST_ID},
             {"schema": transport.SCHEMA, "owner_id": OWNER_ID, "request_id": REQUEST_ID, "state": "unknown"}),
        ):
            with self.fixture(body) as root, patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": ""}), \
                    patch.dict(core._call_tool.__globals__, urlopen=lambda *a, **k: self.fail("Backend HTTP forbidden")):
                actual = core._call_tool(name, args)
                self.assertEqual(actual, {"transport_status": "pipe_response", "response": body})
                evidence = json.loads((root / "received.json").read_text())
                self.assertFalse(evidence["authenticated"])
                self.assertEqual(evidence["fields"], 4)

    def test_restart_accepted_and_owner_mismatch_receipts_are_not_replayed(self):
        core = load_source()
        for state, reason in (("accepted", "ACCEPTED"), ("unknown", "OWNER_MISMATCH"),
                              ("blocked", "BACKEND_PREFLIGHT_NOT_ATTESTED")):
            body = {"schema": transport.SCHEMA, "owner_id": OWNER_ID, "request_id": REQUEST_ID,
                    "state": state, "reason": reason}
            with self.fixture(body) as root, patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": "a" * 64}):
                self.assertEqual(core._call_tool("omi_restart_backend", ARGS)["response"], body)
                evidence = json.loads((root / "received.json").read_text())
                self.assertEqual(evidence, {"action": "RestartBackend", "request_id": REQUEST_ID,
                                           "expected_owner_id": OWNER_ID, "authenticated": True, "fields": 4})

    def test_same_name_wrong_owner_never_receives_credential(self):
        with self.fixture(wrong_script=True) as root:
            with self.assertRaisesRegex(transport.PipeError, "OWNER_NOT_ATTESTED") as caught:
                transport.request(self.message("RestartBackend"))
            self.assertFalse(caught.exception.sent)
            self.assertFalse((root / "received.json").exists())

    def test_creation_change_rejected_before_write(self):
        original = transport._Windows.created
        calls = 0

        def changed(api, handle):
            nonlocal calls
            calls += 1
            return original(api, handle) + (1 if calls > 1 else 0)

        with self.fixture() as root, patch.object(transport._Windows, "created", changed):
            with self.assertRaisesRegex(transport.PipeError, "OWNER_CHANGED") as caught:
                transport.request(self.message("RestartBackend"))
            self.assertFalse(caught.exception.sent)
            self.assertFalse((root / "received.json").exists())

    def test_pid_change_rejected_before_write(self):
        original = transport._Windows.server_pid
        calls = 0

        def changed(api, pipe):
            nonlocal calls
            calls += 1
            return original(api, pipe) + (1 if calls > 1 else 0)

        with self.fixture() as root, patch.object(transport._Windows, "server_pid", changed):
            with self.assertRaisesRegex(transport.PipeError, "OWNER_CHANGED"):
                transport.request(self.message())
            self.assertFalse((root / "received.json").exists())

    def test_post_write_timeout_is_unknown_without_retry(self):
        core = load_source()
        with self.fixture(mode="timeout") as root, patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": "a" * 64}):
            start = time.monotonic()
            with self.assertRaises(core.RuntimeControlError) as caught:
                core._call_tool("omi_restart_backend", ARGS)
            self.assertLess(time.monotonic() - start, 3)
            self.assertEqual(caught.exception.payload, {"error": "RUNTIME_TIMEOUT", "transport_status": "error",
                             "request_id": REQUEST_ID, "outcome": "unknown",
                             "next_action": "read_runtime_operation_same_request_id"})
            self.assertTrue((root / "received.json").exists())

    def test_native_response_size_and_framing_guards(self):
        for raw in ("[]\n", '{"schema":"wrong"}\n', '{"schema":"omi.runtime-control.v1","x":NaN}\n',
                    '{"schema":"omi.runtime-control.v1","schema":"omi.runtime-control.v1"}\n',
                    "x" * (transport.MAX_FRAME + 1) + "\n", '{"schema":"omi.runtime-control.v1"}\n{}\n'):
            with self.subTest(kind=raw[:20]), self.fixture(raw=raw):
                with self.assertRaisesRegex(transport.PipeError, "INVALID_RUNTIME_RESPONSE"):
                    transport.request(self.message())

    def test_exact_process_argument_grammar(self):
        executable = transport._Windows().system_executable()
        launcher = transport.REPO_ROOT + r"\scripts\omi-launcher.ps1"
        args = [executable, "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", launcher]
        self.assertTrue(transport._identity_matches(executable, args, executable, launcher))
        for changed in (args + ["-LauncherAction", "RestartBackend"], args[:-1] + [launcher + ".evil"],
                        args[:7] + ["-Command", launcher], args[:1] + ["-EncodedCommand", "data"],
                        [executable] + args[2:], args[:-1] + [launcher.replace("Open Market", "Other Market")]):
            self.assertFalse(transport._identity_matches(executable, changed, executable, launcher))
        self.assertFalse(transport._identity_matches(executable + ".evil", args, executable, launcher))

    def test_private_response_and_deep_payload_rejected(self):
        for value in ({"path": r"C:\Users\SYNTHETIC\private"}, {"sid": "S-1-5-21-1-2-3"},
                      {"future": {"token": "synthetic"}}, {"unc": r"\\SYNTHETIC\private"}):
            raw = json.dumps({"schema": transport.SCHEMA, **value}).encode()
            with self.assertRaisesRegex(transport.PipeError, "REDACTED"):
                transport._decode(raw)
        with self.assertRaisesRegex(transport.PipeError, "INVALID_RUNTIME_RESPONSE"):
            transport._decode(b'{"schema":"omi.runtime-control.v1","deep":' + b'['*18 + b'0' + b']'*18 + b'}')

    def test_access_denial_has_no_retry_or_alternate_entry(self):
        with patch.object(transport, "_Windows") as api:
            api.return_value.k.CreateFileW.return_value = ctypes.c_void_p(-1).value
            with patch.object(ctypes, "get_last_error", return_value=5), \
                    self.assertRaisesRegex(transport.PipeError, "RUNTIME_PIPE_ACCESS_DENIED") as caught:
                transport.request(self.message("RestartBackend"))
            self.assertFalse(caught.exception.sent)
            api.return_value.k.CreateFileW.assert_called_once()
            api.return_value.owner.assert_not_called()

    def test_owner_change_after_write_is_unknown(self):
        original = transport._Windows.check_pin
        calls = 0

        def changed(api, *args):
            nonlocal calls
            calls += 1
            original(api, *args)
            if calls == 3:
                raise transport.PipeError("RUNTIME_OWNER_CHANGED")

        with self.fixture({"schema": transport.SCHEMA, "request_id": REQUEST_ID, "state": "accepted"}), \
                patch.object(transport._Windows, "check_pin", changed):
            with self.assertRaisesRegex(transport.PipeError, "OWNER_CHANGED") as caught:
                transport.request(self.message("RestartBackend"))
            self.assertTrue(caught.exception.sent)

    def test_unknown_action_never_opens_pipe(self):
        for action in ("UpgradeDBSchema", "ApplyRelease", "shell", "StopBackend"):
            with patch.object(transport, "_Windows") as api, self.assertRaises(transport.PipeError):
                transport.request({**self.message(), "action": action})
            api.assert_not_called()

    def test_actual_controller_backend_absent_status_receipt_and_restart_blocked(self):
        core = load_source()
        with self.fixture(mode="controller_snapshot") as root, \
                patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": "a" * 64}):
            status = core._call_tool("omi_read_runtime_status", {})["response"]
            self.assertEqual(status["schema"], transport.SCHEMA)
            owner = status["owner_id"]
            # These are distinct explicit commands, never transport retries.
            time.sleep(.05)  # Allow single-instance Controller to listen again.
            missing = core._call_tool("omi_read_runtime_operation", {"request_id": REQUEST_ID})["response"]
            self.assertEqual((missing["state"], missing["reason"]), ("unknown", "NOT_FOUND"))
            time.sleep(.05)
            blocked = core._call_tool("omi_restart_backend", {**ARGS, "expected_owner_id": owner})["response"]
            self.assertEqual((blocked["state"], blocked["reason"]), ("blocked", "OWNER_NOT_ATTESTED"))
            self.assertEqual(blocked["owner_id"], owner)
            time.sleep(.05)
            receipt = core._call_tool("omi_read_runtime_operation", {"request_id": REQUEST_ID})["response"]
            self.assertEqual(receipt, blocked)
            self.assertTrue((root / "receipts" / (REQUEST_ID + ".json")).is_file())

    def test_per_action_wire_rejects_confirmation_injection_and_wrong_uuid_before_io(self):
        for action in transport.ACTION_CONFIRMATIONS:
            body = self.message(action)
            invalid = [{**body, key: 'caller-controlled'} for key in (
                'actor', 'shell', 'database_path', 'schema_lock_path', 'backend_preflight', 'approved',
                'request_id', 'expected_owner_id')]
            invalid += [{**body, 'confirmation': value} for value in ('yes', '', 'START_BACKEND', None)]
            if action != 'RestartBackend':
                invalid.append({k: v for k, v in body.items() if k != 'confirmation'})
            for message in invalid:
                with self.subTest(action=action, keys=list(message)), patch.object(transport, '_Windows') as api:
                    with self.assertRaises(transport.PipeError):
                        transport.request(message)
                    api.assert_not_called()

    def test_actual_controller_offline_mutations_accept_consume_once_and_terminal_unknown(self):
        core = load_source()
        for name, (action, confirmation) in core.RUNTIME_MUTATIONS.items():
            if action == 'RestartBackend':
                continue
            with self.subTest(action=action), self.fixture(mode='controller_snapshot') as root, \
                    patch.dict(os.environ, {'OMI_SEARCH_RUNTIME_CONTROL_TOKEN': 'a' * 64}):
                status = core._call_tool('omi_read_runtime_status', {})['response']
                self.assertEqual(status['backend']['status'], 'stopped')
                args = {'request_id': str(uuid4()), 'expected_owner_id': status['owner_id'], 'confirmation': confirmation}
                time.sleep(.05)
                missing = core._call_tool('omi_read_runtime_operation', {'request_id': args['request_id']})['response']
                self.assertEqual((missing['state'], missing['reason']), ('unknown', 'NOT_FOUND'))
                self.assertFalse((root / 'receipts' / (args['request_id'] + '.json')).exists())
                time.sleep(.05)
                accepted = core._call_tool(name, args)['response']
                self.assertEqual((accepted['state'], accepted['reason'], accepted['action']), ('accepted', 'ACCEPTED', action))
                self.assertEqual(accepted['actor'], 'authenticated_pipe_client')
                self.assertEqual(accepted['requester']['pid'], os.getpid())
                self.assertEqual(accepted['confirmation'], confirmation)
                self.assertIsNone(accepted['before'])
                self.assertIsNone(accepted['local_approval'])
                time.sleep(.05)
                read = lambda: core._call_tool('omi_read_runtime_operation', {'request_id': args['request_id']})['response']
                self.assertEqual(read(), accepted)
                (root / 'consume').touch()
                deadline = time.monotonic() + 3
                while not (root / 'consumed.json').exists() and time.monotonic() < deadline:
                    time.sleep(.025)
                evidence = json.loads((root / 'consumed.json').read_text())
                self.assertEqual(evidence, {'action': action, 'first': True, 'second': False, 'pending_after': None})
                time.sleep(.05)
                terminal = read()
                self.assertEqual((terminal['state'], terminal['reason']), ('unknown', 'LIFECYCLE_FAILED'))
                self.assertTrue(terminal['intent_consumed_at'])
                self.assertEqual(terminal['migration_outcome'], 'NOT_ATTEMPTED')
                self.assertIsNone(terminal['after'])
                # Deliberate negative replay against a disposable Controller:
                # same UUID returns its durable unknown, never another intent.
                time.sleep(.05)
                self.assertEqual(core._call_tool(name, args)['response'], terminal)
                time.sleep(.05)
                collision = core._call_tool('omi_restart_backend', {**args, 'confirmation': 'restart_backend'})['response']
                self.assertEqual((collision['state'], collision['reason']), ('unknown', 'CONTROLLER_RECOVERED_NO_REPLAY'))
                self.assertEqual(len(list((root / 'receipts').glob('*.json'))), 1)

    def test_actual_controller_wrong_token_owner_and_recycled_client_binding(self):
        core = load_source()
        for binding in ('absent', 'recycled'):
            with self.fixture(mode='controller_snapshot', binding=binding) as root:
                status = core._call_tool('omi_read_runtime_status', {})['response']
                for name, (_, confirmation) in core.RUNTIME_MUTATIONS.items():
                    args = {'request_id': str(uuid4()), 'expected_owner_id': status['owner_id'], 'confirmation': confirmation}
                    time.sleep(.05)
                    with patch.dict(os.environ, {'OMI_SEARCH_RUNTIME_CONTROL_TOKEN': 'b' * 64}):
                        denied = core._call_tool(name, args)['response']
                    self.assertEqual(denied['error'], 'RUNTIME_CONTROL_FORBIDDEN')
                    self.assertFalse((root / 'receipts' / (args['request_id'] + '.json')).exists())
                    time.sleep(.05)
                    with patch.dict(os.environ, {'OMI_SEARCH_RUNTIME_CONTROL_TOKEN': 'a' * 64}):
                        wrong_owner = core._call_tool(name, {**args, 'expected_owner_id': str(uuid4())})['response']
                        self.assertEqual(wrong_owner['reason'], 'OWNER_MISMATCH')
                        if binding == 'recycled':
                            time.sleep(.05)
                            denied = core._call_tool(name, args)['response']
                            self.assertEqual((denied['state'], denied['reason']), ('blocked', 'BACKEND_PREFLIGHT_NOT_ATTESTED'))

    def test_actual_controller_restart_accepts_independent_caller_with_owned_binding(self):
        # Only admission: synthetic owned binding is the fixture Launcher process,
        # never an actual Backend or stop/start verification.
        core = load_source()
        with self.fixture(mode='controller_snapshot', binding='owned') as root, \
                patch.dict(os.environ, {'OMI_SEARCH_RUNTIME_CONTROL_TOKEN': 'a' * 64}):
            status = core._call_tool('omi_read_runtime_status', {})['response']
            time.sleep(.05)
            accepted = core._call_tool('omi_restart_backend', {**ARGS, 'expected_owner_id': status['owner_id']})['response']
            self.assertEqual(accepted['state'], 'accepted')
            self.assertEqual(accepted['requester']['pid'], os.getpid())
            self.assertNotEqual(accepted['before']['pid'], os.getpid())
            time.sleep(.05)
            self.assertEqual(core._call_tool('omi_read_runtime_operation', {'request_id': REQUEST_ID})['response'], accepted)


if __name__ == "__main__":
    unittest.main()
