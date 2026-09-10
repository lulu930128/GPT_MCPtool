"""Test-only host for the real Trainer source with a separate data directory.

No copied models. Exits on stdin EOF and terminates only its own Popen handles.
"""
import argparse
import json
import os
import sys
import threading
from dataclasses import replace
from http.server import ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--data", required=True)
args = parser.parse_args()
sys.path.insert(0, str(Path(args.root).resolve() / "src"))
from jlpt_trainer.app import TrainerApp, make_handler
from jlpt_trainer.settings import load_settings

data = Path(args.data).resolve()
data.mkdir(parents=True, exist_ok=True)
settings = replace(load_settings(), host="127.0.0.1", port=0, data_dir=data,
                   sets_dir=data / "sets", audio_dir=data / "audio", results_dir=data / "results",
                   sessions_dir=data / "sessions", tts_runtime_dir=data / "tts_runtime")
if os.environ.get("LISTENING_TTS_IMPORT_DEBUG") == "1":
    os.environ["PYTHONPROFILEIMPORTTIME"] = "1"
app = TrainerApp(settings)
server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
print("LISTENING_READY " + json.dumps({"port": server.server_address[1]}), flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    server.server_close()
    for process in list(app.tts.processes.values()):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except Exception:
                process.kill()
                process.wait(timeout=5)
    thread.join(timeout=5)
