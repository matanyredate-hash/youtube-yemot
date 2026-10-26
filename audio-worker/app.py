import os
import re
import tempfile
from pathlib import Path
from io import BytesIO
from flask import Flask, request, jsonify, send_file
from yt_dlp import YoutubeDL

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024

@app.get("/")
def health():
    return jsonify({"service": "Yemot Tube audio worker", "status": "online"})

@app.post("/audio")
def audio():
    expected = os.environ.get("WORKER_TOKEN", "")
    supplied = request.headers.get("X-Worker-Token", "")
    if not expected or supplied != expected:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    video_id = str(body.get("videoId", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return jsonify({"error": "Invalid YouTube video ID"}), 400

    with tempfile.TemporaryDirectory(prefix="yemot-audio-") as tmp:
        output = str(Path(tmp) / "track.%(ext)s")
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio",
            "outtmpl": output,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "socket_timeout": 20,
            "retries": 1,
            "extractor_retries": 1,
            "max_filesize": 45 * 1024 * 1024,
            "match_filter": lambda info, *, incomplete: "Video exceeds 20 minutes" if info.get("duration") and info["duration"] > 1200 else None,
        }
        try:
            with YoutubeDL(opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            candidates = [p for p in Path(tmp).iterdir() if p.is_file() and p.name.startswith("track.")]
            if not candidates:
                return jsonify({"error": "Audio extraction produced no file"}), 502
            audio_path = candidates[0]
            if audio_path.stat().st_size == 0 or audio_path.stat().st_size > 45 * 1024 * 1024:
                return jsonify({"error": "Audio file size is not supported"}), 413
            audio_bytes = audio_path.read_bytes()
            return send_file(BytesIO(audio_bytes), mimetype="application/octet-stream", as_attachment=True, download_name="selected-audio.bin")
        except Exception as exc:
            app.logger.warning("yt-dlp extraction failed: %s", type(exc).__name__)
            return jsonify({"error": "Audio extraction failed; check worker logs"}), 502

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "10000")))
