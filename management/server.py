"""iPod management service. Nginx authenticates requests to its Unix socket."""
import json
import os
import shutil
import socketserver
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

BASE = Path(__file__).resolve().parent
STATE = Path(os.environ.get("IPOD_STATE", "/var/lib/ipod-manager"))
CATALOG = STATE / "catalog.json"
UPLOADS = STATE / "audio"
LOCK = threading.Lock()
MAX_AUDIO = 128 * 1024 * 1024
START = {"home", "listen", "albums", "artists", "genres", "playlists", "songs", "store", "links"}
ORIGIN = "https://manageipod.laposabulb.com"


def save(data):
    with tempfile.NamedTemporaryFile(dir=STATE, delete=False, mode="w") as f:
        try:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
            os.chmod(f.name, 0o644)
            os.replace(f.name, CATALOG)
        finally:
            Path(f.name).unlink(missing_ok=True)


def field(data, name):
    value = data.get(name)
    if not isinstance(value, str) or not 0 < len(value.strip()) <= 160:
        raise ValueError("Controlla i campi del modulo.")
    return value.strip()


def genre_name(data):
    value = data.get("genre", "")
    if not isinstance(value, str) or len(value.strip()) > 160:
        raise ValueError("Il genere deve contenere al massimo 160 caratteri.")
    return value.strip()


def edit_track(catalog, data):
    url = data.get("track")
    albums = catalog["albums"]
    playlists = catalog.get("playlists", [])
    source, track = next(((a, t) for a in albums for t in a["tracks"] if t["url"] == url), (None, None))
    if track is None:
        raise ValueError("Brano non trovato.")
    current = {
        "artist": track.get("artistId", source["artistId"]),
        "album": source["id"],
        "genre": track.get("genre", ""),
        "playlists": [p["id"] for p in playlists if url in p["tracks"]],
    }
    if current != data.get("original"):
        raise ValueError("Il brano è stato aggiornato. Ricarica la pagina prima di modificarlo.")
    artist = field(data, "artist")
    if all(a["id"] != artist for a in catalog["artists"]):
        raise ValueError("Scegli un artista del catalogo.")
    target = next((a for a in albums if a["id"] == data.get("album")), None)
    if target is None:
        raise ValueError("Scegli un album del catalogo.")
    memberships = data.get("playlists")
    valid_ids = {p["id"] for p in playlists}
    if not isinstance(memberships, list) or any(not isinstance(i, str) or i not in valid_ids for i in memberships):
        raise ValueError("Controlla le playlist selezionate.")
    track["genre"] = genre_name(data)
    track["artistId"] = artist
    if source is not target:
        source["tracks"].remove(track)
        target["tracks"].append(track)
    for playlist in playlists:
        entries = playlist["tracks"]
        if playlist["id"] in memberships:
            if url not in entries:
                entries.append(url)
        elif url in entries:
            entries.remove(url)


def update(catalog, action, data):
    if action == "edit-track":
        edit_track(catalog, data)
        return
    if action in ("genre", "playlist-track"):
        url = data.get("track")
        track = next((t for album in catalog["albums"] for t in album["tracks"] if t["url"] == url), None)
        if track is None:
            raise ValueError("Scegli un brano del catalogo.")
        if action == "genre":
            track["genre"] = genre_name(data)
            return
        playlist = next((p for p in catalog.get("playlists", []) if p["id"] == data.get("playlist")), None)
        if playlist is None:
            raise ValueError("Scegli una playlist.")
        if url in playlist["tracks"]:
            raise ValueError("Il brano è già nella playlist.")
        playlist["tracks"].append(url)
        return
    if action == "start":
        start = field(data, "start")
        if start not in START and all(a["id"] != start for a in catalog["albums"]):
            raise ValueError("Schermata sconosciuta.")
        catalog["start"] = start
        return
    label = field(data, "label")
    entry = {"id": str(uuid.uuid4()), "label": label}
    if action == "artist":
        entries = catalog["artists"]
    elif action == "playlist":
        entries = catalog.setdefault("playlists", [])
        entry["tracks"] = []
    else:
        artist = field(data, "artist")
        if all(a["id"] != artist for a in catalog["artists"]):
            raise ValueError("Scegli un artista.")
        entry.update(artistId=artist, tracks=[])
        entries = catalog["albums"]
    if any(e["label"].casefold() == label.casefold() and e.get("artistId") == entry.get("artistId") for e in entries):
        raise ValueError("Questo nome è già nel catalogo.")
    entries.append(entry)


def audio_extension(header):
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return ".wav"
    if header.startswith(b"fLaC"):
        return ".flac"
    if header.startswith(b"OggS"):
        return ".ogg"
    if header[4:8] == b"ftyp" and header[8:12] in (b"M4A ", b"isom", b"mp42"):
        return ".m4a"
    if header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 255 and header[1] & 224 == 224):
        return ".mp3"
    raise ValueError("Formato audio non riconosciuto.")


class Handler(BaseHTTPRequestHandler):
    def address_string(self):
        return "nginx"

    def respond(self, status, body, mime="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/catalog":
            self.respond(200, CATALOG.read_bytes())
        elif self.path in ("/", "/admin.js", "/admin.css"):
            name, mime = {"/": ("admin.html", "text/html; charset=utf-8"),
                          "/admin.js": ("admin.js", "application/javascript"),
                          "/admin.css": ("admin.css", "text/css")}[self.path]
            self.respond(200, (BASE / name).read_bytes(), mime)
        else:
            self.respond(404, b"{}")

    def track(self, size, query):
        label, album_id = field(query, "label"), field(query, "album")
        genre = genre_name(query)
        with tempfile.TemporaryFile(dir=STATE) as f:
            remaining = size
            while remaining:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise ValueError("Caricamento interrotto.")
                f.write(chunk)
                remaining -= len(chunk)
            f.seek(0)
            name = uuid.uuid4().hex + audio_extension(f.read(32))
            f.seek(0)
            with LOCK:
                catalog = json.loads(CATALOG.read_bytes())
                album = next((a for a in catalog["albums"] if a["id"] == album_id), None)
                if album is None:
                    raise ValueError("Scegli un album.")
                path = UPLOADS / name
                try:
                    with path.open("xb") as dest:
                        shutil.copyfileobj(f, dest)
                    path.chmod(0o644)
                    album["tracks"].append({"label": label, "genre": genre, "url": "uploaded-audio/" + name})
                    save(catalog)
                except Exception:
                    path.unlink(missing_ok=True)
                    raise

    def do_POST(self):
        if self.headers.get("Origin") != ORIGIN:
            return self.respond(403, b"{}")
        url = urlsplit(self.path)
        if url.path not in ("/api/artist", "/api/album", "/api/track", "/api/start", "/api/genre", "/api/edit-track", "/api/playlist", "/api/playlist-track"):
            return self.respond(404, b"{}")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            track = url.path == "/api/track"
            if not 0 < size <= (MAX_AUDIO if track else 8192):
                return self.respond(413, b'{"error":"Dimensione non valida."}')
            if track:
                self.track(size, {k: v[0] for k, v in parse_qs(url.query).items()})
            else:
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError("Modulo non valido.")
                with LOCK:
                    catalog = json.loads(CATALOG.read_bytes())
                    update(catalog, url.path.split("/")[-1], data)
                    save(catalog)
            self.respond(200, b'{"ok":true}')
        except ValueError as error:
            self.respond(400, json.dumps({"error": str(error)}).encode())
        except OSError:
            self.respond(500, b'{"error":"Salvataggio non riuscito."}')


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


if __name__ == "__main__":
    UPLOADS.mkdir(parents=True, exist_ok=True)
    sock = Path(os.environ.get("IPOD_SOCKET", "/run/ipod-manager/http.sock"))
    sock.unlink(missing_ok=True)
    with Server(str(sock), Handler) as server:
        os.chmod(sock, 0o660)
        server.serve_forever()
