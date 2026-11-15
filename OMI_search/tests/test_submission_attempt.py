import json
import unittest

import anyio
from submission_attempt_fixture import mcp_receipt, receipt_body


class SubmissionAttemptTests(unittest.TestCase):
    def test_http_errors_through_registered_mcp_preserve_original_typed_envelope(self):
        for middleware in (True, False):
            with self.subTest(middleware=middleware):
                body = receipt_body(middleware)
                wire = anyio.run(mcp_receipt, body)
                self.assertTrue(wire["isError"])
                value = wire["structuredContent"]
                self.assertEqual(value["http_status"], 503)
                self.assertEqual(value["tool"], "omi_confirm_desk_staged")
                self.assertEqual(value["backend_error"], body)
                self.assertEqual(json.loads(wire["content"][0]["text"]), value)

    def test_conflict_and_unknown_are_forwarded_without_manufacturing_receipts(self):
        for code, status in (("STALE_STAGE_SELECTION", 409), ("EXECUTOR_RESPONSE_UNKNOWN", 503)):
            body = {"error": {"code": code, "message": "Request failed.", "detail": {"retry_policy": "CHECK_STATUS_DO_NOT_RESEND"}}}
            wire = anyio.run(mcp_receipt, body, status)
            self.assertEqual(wire["structuredContent"]["backend_error"], body)
            self.assertNotIn("submission_attempt", wire["structuredContent"]["backend_error"]["error"]["detail"])
