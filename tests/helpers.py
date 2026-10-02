"""Shared helpers for the test suite.

Standard library only (urllib, not httpx): nothing to install, and urllib uses
the Windows certificate store, so the tests also work on school Wi-Fi where
TLS interception breaks certifi-based clients.
"""

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"


def load_env() -> None:
    """Read backend/.env into os.environ without overriding real env vars."""
    env = ROOT / "backend" / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def public_config() -> dict:
    """The URL and anon key the browser uses, read from frontend/config.js."""
    text = (FRONTEND / "config.js").read_text(encoding="utf-8")
    url = re.search(r'SUPABASE_URL\s*=\s*"([^"]+)"', text).group(1)
    key = re.search(r'SUPABASE_ANON_KEY\s*=\s*"([^"]+)"', text).group(1)
    return {"url": url, "key": key}


class Response:
    def __init__(self, status: int, body: str):
        self.status = status
        self.text = body
        try:
            self.json = json.loads(body) if body else None
        except ValueError:
            self.json = None

    @property
    def message(self) -> str:
        if isinstance(self.json, dict):
            return str(self.json.get("message") or self.json.get("error") or "")
        return self.text

    def __repr__(self) -> str:
        return f"<{self.status} {self.text[:160]}>"


def request(method: str, url: str, body=None, token: str | None = None, timeout=30) -> Response:
    cfg = public_config()
    headers = {
        "apikey": cfg["key"],
        "Authorization": f"Bearer {token or cfg['key']}",
        "Content-Type": "application/json",
    }
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return Response(res.status, res.read().decode())
    except urllib.error.HTTPError as err:
        return Response(err.code, err.read().decode())


def rpc(name: str, body: dict | None = None) -> Response:
    """Call a database function exactly as anyone holding the public key could."""
    return request("POST", f"{public_config()['url']}/rest/v1/rpc/{name}", body or {})


def table(name: str) -> Response:
    return request("GET", f"{public_config()['url']}/rest/v1/{name}?select=*&limit=1")


def edge(body: dict, token: str | None = None) -> Response:
    return request("POST", f"{public_config()['url']}/functions/v1/moderate-suggestion", body, token)


def is_refused(res: Response) -> bool:
    """Postgres permission errors come back as 401/403 with code 42501."""
    code = res.json.get("code") if isinstance(res.json, dict) else None
    return res.status in (401, 403) and (code in (None, "42501", "PGRST301", "PGRST302") or "denied" in res.text)
