"""Run real Hub and Trainer APIs on ephemeral loopback ports with disposable data."""
import argparse
import json
import os
import socket
import sys
import threading
import time
from dataclasses import replace
from http.server import ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--hub-root", required=True)
parser.add_argument("--trainer-root", required=True)
parser.add_argument("--data", required=True)
args = parser.parse_args()
data = Path(args.data).resolve()
data.mkdir(parents=True, exist_ok=True)
sys.path[:0] = [str(Path(args.hub_root).resolve() / "src"), str(Path(args.trainer_root).resolve() / "src")]
os.environ.update(ESTUDY_DATA_DIR=str(data / "hub"), ESTUDY_DB_PATH=str(data / "hub/study.db"),
    ESTUDY_REFERENCE_DIR=str(data / "reference"), ESTUDY_REFERENCE_DB_PATH=str(data / "reference/catalog.db"),
    ESTUDY_API_TOKEN="", JLPT_TTS_MODE="central", JLPT_VOICE_RUNTIME_URL="http://127.0.0.1:1")
import uvicorn
from english_study_hub.api import app as hub
from jlpt_trainer.app import TrainerApp, make_handler
from jlpt_trainer.settings import load_settings

settings = replace(load_settings(), host="127.0.0.1", port=0, data_dir=data / "trainer",
    sets_dir=data / "sets", audio_dir=data / "audio", results_dir=data / "results",
    sessions_dir=data / "sessions", tts_runtime_dir=data / "tts_runtime")
trainer = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(TrainerApp(settings)))
socket_hub = socket.socket()
socket_hub.bind(("127.0.0.1", 0))
config = uvicorn.Config(hub, log_level="error")
server = uvicorn.Server(config)
threads = [threading.Thread(target=trainer.serve_forever, daemon=True),
           threading.Thread(target=lambda: server.run(sockets=[socket_hub]), daemon=True)]
for thread in threads:
    thread.start()
try:
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError("Hub startup timed out")
        time.sleep(.02)
    print("IELTS_READY " + json.dumps(dict(hubPort=socket_hub.getsockname()[1], trainerPort=trainer.server_address[1])), flush=True)
    sys.stdin.readline()
finally:
    server.should_exit = True
    trainer.shutdown()
    trainer.server_close()
    for thread in threads:
        thread.join(timeout=5)
    socket_hub.close()
