"""Bounded client for the existing OMI Launcher; no lifecycle authority.

Only the fixed repository/Windows PowerShell -File identity is trusted. No
inherited Backend PID, endpoint configuration, process launch or HTTP fallback.
"""
from contextlib import contextmanager
import ctypes as c
from ctypes import wintypes as w
from hashlib import sha256
import json
import ntpath
import os
import re
import time
from uuid import UUID


REPO_ROOT = r"C:\project\Open Market Intelligence"
MAX_FRAME = 16384
TIMEOUT_SECONDS = 2.0
SCHEMA = "omi.runtime-control.v1"
ACTION_CONFIRMATIONS = {
    "RestartBackend": "restart_backend",
    "StartBackend": "start_backend",
    "RecoverFailedStart": "recover_failed_start",
    "SchemaUpgrade": "upgrade_schema",
}


class PipeError(Exception):
    """Fixed diagnostic only. Never carry native exceptions or command lines."""

    def __init__(self, code, *, sent=False):
        super().__init__(code)
        self.code = code
        self.sent = sent


def _identity_matches(executable, arguments, expected_executable, launcher):
    # Exact token grammar of start-omi-launcher-hidden.vbs. Do not accept
    # -Command, encoded commands, abbreviated switches, profiles or extra args.
    expected = [expected_executable, "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-STA", "-WindowStyle", "Hidden", "-File", launcher]
    return (ntpath.normcase(executable) == ntpath.normcase(expected_executable)
            and [s.casefold() for s in arguments] == [s.casefold() for s in expected])


class _Windows:
    def __init__(self):
        if os.name != "nt":
            raise PipeError("RUNTIME_WINDOWS_REQUIRED")
        self.k = c.WinDLL("kernel32", use_last_error=True)
        self.n = c.WinDLL("ntdll")
        self.s = c.WinDLL("shell32", use_last_error=True)
        self.a = c.WinDLL("advapi32", use_last_error=True)
        signatures = {
            "CreateFileW": ([w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
            "CloseHandle": ([w.HANDLE], w.BOOL),
            "GetNamedPipeServerProcessId": ([w.HANDLE, c.POINTER(w.ULONG)], w.BOOL),
            "OpenProcess": ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            "GetProcessTimes": ([w.HANDLE] + [c.POINTER(w.FILETIME)] * 4, w.BOOL),
            "QueryFullProcessImageNameW": ([w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)], w.BOOL),
            "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
            "GetCurrentProcess": ([], w.HANDLE),
            "GetSystemDirectoryW": ([w.LPWSTR, w.UINT], w.UINT),
            "LocalFree": ([c.c_void_p], c.c_void_p),
            "SetNamedPipeHandleState": ([w.HANDLE, c.POINTER(w.DWORD), c.c_void_p, c.c_void_p], w.BOOL),
            "ReadFile": ([w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p], w.BOOL),
            "WriteFile": ([w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.k, name)
            fn.argtypes, fn.restype = args, result
        self.n.NtQueryInformationProcess.argtypes = [w.HANDLE, w.ULONG, c.c_void_p, w.ULONG, c.POINTER(w.ULONG)]
        self.n.NtQueryInformationProcess.restype = w.LONG
        self.s.CommandLineToArgvW.argtypes = [w.LPCWSTR, c.POINTER(c.c_int)]
        self.s.CommandLineToArgvW.restype = c.POINTER(w.LPWSTR)
        self.a.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)]
        self.a.GetTokenInformation.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)]
        self.a.GetLengthSid.argtypes = [c.c_void_p]
        self.a.GetLengthSid.restype = w.DWORD

    def system_executable(self):
        buf = c.create_unicode_buffer(32768)
        size = self.k.GetSystemDirectoryW(buf, len(buf))
        if not 0 < size < len(buf):
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        return ntpath.join(buf.value, "WindowsPowerShell", "v1.0", "powershell.exe")

    def server_pid(self, pipe):
        pid = w.ULONG()
        if not self.k.GetNamedPipeServerProcessId(pipe, c.byref(pid)) or not pid.value:
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        return pid.value

    def created(self, process):
        times = [w.FILETIME() for _ in range(4)]
        if not self.k.GetProcessTimes(process, *(c.byref(t) for t in times)):
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        value = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
        if not value:
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        return value

    def user_sid(self, process):
        token = w.HANDLE()
        if not self.a.OpenProcessToken(process, 8, c.byref(token)):
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        try:
            size = w.DWORD()
            self.a.GetTokenInformation(token, 1, None, 0, c.byref(size))
            if not 0 < size.value <= 4096:
                raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
            buf = c.create_string_buffer(size.value)
            if not self.a.GetTokenInformation(token, 1, buf, size, c.byref(size)):
                raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
            sid = c.c_void_p.from_buffer(buf).value
            length = self.a.GetLengthSid(sid)
            if not 0 < length <= 68:
                raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
            return c.string_at(sid, length)  # Compared locally only; never serialized.
        finally:
            self.k.CloseHandle(token)

    def command_arguments(self, process):
        class UnicodeString(c.Structure):
            _fields_ = [("length", w.USHORT), ("maximum", w.USHORT), ("buffer", c.c_void_p)]

        # Query only the command line (class 60); never read the PEB/environment.
        # Unsupported OS/native API or access denial fails closed, no fallback.
        size = w.ULONG()
        self.n.NtQueryInformationProcess(process, 60, None, 0, c.byref(size))
        if not c.sizeof(UnicodeString) <= size.value <= 65536:
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        buf = c.create_string_buffer(size.value)
        if self.n.NtQueryInformationProcess(process, 60, buf, len(buf), c.byref(size)) < 0:
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        value = UnicodeString.from_buffer(buf)
        start = c.addressof(buf)
        if (not value.buffer or value.length % 2 or not value.length
                or value.buffer < start or value.buffer + value.length > start + len(buf)):
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        command = c.wstring_at(value.buffer, value.length // 2)
        if "\0" in command:
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        count = c.c_int()
        argv = self.s.CommandLineToArgvW(command, c.byref(count))
        if not argv:
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        try:
            if not 1 <= count.value <= 16:
                raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
            return [argv[i] for i in range(count.value)]
        finally:
            self.k.LocalFree(argv)

    def check_pin(self, pipe, process, pid, created):
        if (self.server_pid(pipe) != pid or self.created(process) != created
                or self.k.WaitForSingleObject(process, 0) != 258):
            raise PipeError("RUNTIME_OWNER_CHANGED")

    @contextmanager
    def owner(self, pipe):
        pid = self.server_pid(pipe)
        # Retain the exact process object through response verification. PID
        # reuse cannot replace this handle or reset its signalled exit state.
        process = self.k.OpenProcess(0x1000 | 0x100000, False, pid)
        if not process:
            raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
        try:
            created = self.created(process)
            executable = c.create_unicode_buffer(32768)
            size = w.DWORD(len(executable))
            if not self.k.QueryFullProcessImageNameW(process, 0, executable, c.byref(size)):
                raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
            if (not _identity_matches(executable.value, self.command_arguments(process), self.system_executable(),
                                      ntpath.join(REPO_ROOT, "scripts", "omi-launcher.ps1"))
                    or self.user_sid(process) != self.user_sid(self.k.GetCurrentProcess())):
                raise PipeError("RUNTIME_OWNER_NOT_ATTESTED")
            self.check_pin(pipe, process, pid, created)
            yield lambda: self.check_pin(pipe, process, pid, created)
        finally:
            self.k.CloseHandle(process)


def _decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError
            result[key] = value
        return result

    def safe(value, depth=0):
        if depth > 16:
            raise ValueError
        if isinstance(value, str):
            if re.search(r"(?i)(?:[a-z]:[\\/]|\\\\|\bS-1-\d+(?:-\d+)+)", value):
                raise PipeError("RUNTIME_RESPONSE_REDACTED")
        elif isinstance(value, list):
            for item in value:
                safe(item, depth + 1)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key.casefold() in {"token", "password", "credential", "authorization", "token_sha256"}:
                    raise PipeError("RUNTIME_RESPONSE_REDACTED")
                safe(key, depth + 1)
                safe(item, depth + 1)

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(value, dict) or value.get("schema") != SCHEMA:
            raise ValueError
        json.dumps(value, allow_nan=False)
        safe(value)
        return value
    except (ValueError, UnicodeError, TypeError, RecursionError):
        raise PipeError("INVALID_RUNTIME_RESPONSE") from None


def request(message):
    """Exactly one connection/write. Credential validation belongs to server.py."""
    if not isinstance(message, dict) or not all(isinstance(v, str) for v in message.values()):
        raise PipeError("INVALID_RUNTIME_ARGUMENTS")
    action = message.get("action")
    keys = {"action", "request_id", "expected_owner_id", "token"}
    if action in ACTION_CONFIRMATIONS and action != "RestartBackend":
        keys.add("confirmation")
    if (action not in {"Status", "ReadOperation", *ACTION_CONFIRMATIONS} or set(message) != keys
            or ("confirmation" in keys and message["confirmation"] != ACTION_CONFIRMATIONS[action])):
        raise PipeError("INVALID_RUNTIME_ARGUMENTS")
    try:
        for key in ("request_id", "expected_owner_id"):
            used = action in ACTION_CONFIRMATIONS or (action == "ReadOperation" and key == "request_id")
            if (used and str(UUID(message[key])) != message[key].lower()) or (not used and message[key] != ""):
                raise ValueError
        if action not in ACTION_CONFIRMATIONS and message["token"] != "":
            raise ValueError
    except (ValueError, AttributeError):
        raise PipeError("INVALID_RUNTIME_ARGUMENTS") from None
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(payload) > MAX_FRAME:
        raise PipeError("INVALID_RUNTIME_ARGUMENTS")
    api = _Windows()
    name = "\\\\.\\pipe\\omi-runtime-" + sha256(REPO_ROOT.lower().encode("utf-8")).hexdigest()[:24]
    # Identification only: a fake pipe must not impersonate the credentialed
    # adapter even before owner validation. No WaitNamedPipe/reconnect/retry.
    pipe = api.k.CreateFileW(name, 0xC0000000, 0, None, 3, 0x100000 | 0x10000, None)
    if pipe == c.c_void_p(-1).value:
        raise PipeError("RUNTIME_PIPE_ACCESS_DENIED" if c.get_last_error() == 5 else "RUNTIME_UNAVAILABLE")
    sent = False
    try:
        deadline = time.monotonic() + TIMEOUT_SECONDS
        with api.owner(pipe) as check_pin:
            mode = w.DWORD(1)  # PIPE_NOWAIT, byte mode: bounded read and write.
            if not api.k.SetNamedPipeHandleState(pipe, c.byref(mode), None, None):
                raise PipeError("RUNTIME_PIPE_MODE_UNAVAILABLE")
            check_pin()
            if time.monotonic() >= deadline:
                raise PipeError("RUNTIME_TIMEOUT")
            count = w.DWORD()
            sent = True  # A partial/failed write can still have reached owner.
            if not api.k.WriteFile(pipe, payload, len(payload), c.byref(count), None) or count.value != len(payload):
                raise PipeError("RUNTIME_UNAVAILABLE")
            result = bytearray()
            while time.monotonic() < deadline:
                buf = c.create_string_buffer(4096)
                count = w.DWORD()
                ok = api.k.ReadFile(pipe, buf, len(buf), c.byref(count), None)
                if count.value:
                    result.extend(buf.raw[:count.value])
                    if len(result) > MAX_FRAME:
                        raise PipeError("INVALID_RUNTIME_RESPONSE")
                    if b"\n" in result:
                        line, tail = result.split(b"\n", 1)
                        if tail:
                            raise PipeError("INVALID_RUNTIME_RESPONSE")
                        check_pin()
                        return _decode(line)
                elif not ok and c.get_last_error() not in {232, 536}:
                    raise PipeError("RUNTIME_UNAVAILABLE")
                time.sleep(0.01)
            raise PipeError("RUNTIME_TIMEOUT")
    except PipeError as exc:
        raise PipeError(exc.code, sent=sent) from None
    except Exception:
        raise PipeError("RUNTIME_TRANSPORT_ERROR", sent=sent) from None
    finally:
        api.k.CloseHandle(pipe)
