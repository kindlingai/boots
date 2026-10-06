"""Scripted OpenAI-compatible server for the end-to-end test.

Worker requests (with tools) follow a per-recipe script indexed by how many
assistant turns the conversation already has. Requests without tools are
the advisor: "ping" gets "ok", anything else gets canned advice.
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

TARGET = os.environ["AIBOOT_TEST_TARGET"]


def call(name, **args):
    return {"name": name, "arguments": args}


SCRIPTS = {
    "10-hello": [
        [call("bash", command="uname -s")],
        [call("write_file", path=TARGET, content="hello\n", mode="0600")],
        [call("finish", summary="wrote the file")],          # verify fails: no "world"
        [call("bash", command=f"echo world >> {TARGET}")],
        [call("finish", summary="added world")],
    ],
    "20-hard": [
        "TEXT_TOOL_CALL",                                    # <tool_call> fallback
        [call("bash", command="wipefs --help")],             # refused by the seatbelt
        [call("consult", question="is this fine?")],
        [call("read_file", path=TARGET)],
        [call("finish", summary="checked")],
    ],
}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send({"data": [{"id": "mock-big-30b"}]})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["content-length"])))
        msgs = req["messages"]
        if "tools" not in req:
            text = "ok" if msgs[-1]["content"] == "ping" else "ADVICE: looks fine, read the file then finish."
            return self._send({"choices": [{"message": {"role": "assistant", "content": text}}]})
        task = next(m["content"] for m in msgs if m["role"] == "user")
        name = re.search(r"Recipe `([^`]+)`", task).group(1)
        step = sum(1 for m in msgs if m["role"] == "assistant")
        script = SCRIPTS[name]
        entry = script[min(step, len(script) - 1)]
        if entry == "TEXT_TOOL_CALL":
            content = '<tool_call>\n{"name": "bash", "arguments": {"command": "echo via-text"}}\n</tool_call>'
            msg = {"role": "assistant", "content": content}
        else:
            msg = {"role": "assistant", "content": f"step {step}", "tool_calls": [
                {"id": f"c{step}{i}", "type": "function",
                 "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
                for i, c in enumerate(entry)]}
        sys.stderr.write(f"mock: {name} step {step}\n")
        self._send({"choices": [{"message": msg, "finish_reason": "tool_calls"}]})


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
