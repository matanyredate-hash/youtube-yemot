const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YEMOT_USERNAME = process.env.YEMOT_USERNAME;
const YEMOT_PASSWORD = process.env.YEMOT_PASSWORD;
const YEMOT_API_BASE = "https://www.call2all.co.il/ym/api/";

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Yemot YouTube Search",
    status: "online"
  });
});

// Checks Yemot credentials without returning or logging the password/token.
app.post("/yemot-test", async (req, res) => {
  if (!YEMOT_USERNAME || !YEMOT_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: "Yemot credentials are not configured in Vercel"
    });
  }

  let token;

  try {
    const body = new URLSearchParams({
      username: YEMOT_USERNAME,
      password: YEMOT_PASSWORD
    });

    const loginResponse = await fetch(`${YEMOT_API_BASE}Login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!loginResponse.ok) {
      return res.status(502).json({
        success: false,
        error: "Yemot login request failed",
        httpStatus: loginResponse.status
      });
    }

    const loginData = await loginResponse.json();

    if (loginData.responseStatus !== "OK" || !loginData.token) {
      return res.status(401).json({
        success: false,
        error: "Yemot rejected the login. Check the system number and management password."
      });
    }

    token = loginData.token;

    // Log out after a successful check; never return the token.
    try {
      const logoutBody = new URLSearchParams({ token });
      await fetch(`${YEMOT_API_BASE}Logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: logoutBody
      });
    } catch (logoutError) {
      console.error("Yemot logout check failed.");
    }

    return res.json({
      success: true,
      message: "Yemot login successful. Credentials were accepted."
    });
  } catch (error) {
    console.error("Yemot connection test failed.");
    return res.status(502).json({
      success: false,
      error: "Could not reach Yemot API. Try again later."
    });
  }
});


// Yemot extension connection test: Yemot expects plain text, not JSON.
app.get("/yemot", (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send("החיבור לשרת עובד.");
});


// Yemot IVR flow. Start with a free recording; the next call sends its path in SONG.
app.get("/yemot-search", async (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  try {
    const cleanForTts = (value) => String(value || "")
      .replace(/[&=<>]/g, " ")
      .replace(/[\r\n]+/g, " ")
      .replace(/[“”"']/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);

    let songQuery = String(req.query.SONG || "").trim();
    const choice = String(req.query.CHOICE || "").trim();

    // Safe diagnostics: never log the spoken query, credentials, tokens, or audio.
    console.log("IVR request diagnostics:", JSON.stringify({
      keys: Object.keys(req.query),
      hasSong: Boolean(songQuery),
      songLooksLikeRecordingPath: songQuery.toLowerCase().endsWith(".wav") || (songQuery.startsWith("/") && songQuery.includes("/")),
      hasChoice: Boolean(choice),
      choice: /^[1-5]$/.test(choice) ? choice : (choice ? "invalid" : ""),
      hangup: String(req.query.hangup || "").toLowerCase() === "yes"
    }));

    // A hangup callback can still include the saved recording path. Process it when present.
    if (String(req.query.hangup || "").toLowerCase() === "yes" && !songQuery && !choice) {
      return res.send("OK");
    }

    if (!songQuery) {
      const fileName = `song_${Date.now()}`;
      return res.send(
        `read=t-אמרו את שם השיר או הזמר, ולאחר מכן הקישו סולמית=SONG,,record,/9,${fileName},no,yes`
      );
    }

    if (/\.wav(?:$|\?)/i.test(songQuery) || /^\/[^/]+\//.test(songQuery)) {
      if (!YEMOT_USERNAME || !YEMOT_PASSWORD || !process.env.GEMINI_API_KEY) {
        return res.send("id_list_message=t-חסר מפתח Gemini או פרטי חיבור בשרת.");
      }
      const loginBody = new URLSearchParams({ username: YEMOT_USERNAME, password: YEMOT_PASSWORD });
      const loginResponse = await fetch(`${YEMOT_API_BASE}Login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: loginBody
      });
      const loginData = await loginResponse.json();
      if (!loginResponse.ok || loginData.responseStatus !== "OK" || !loginData.token) {
        return res.send("id_list_message=t-לא הצלחתי להתחבר לימות.");
      }

      const recordedPath = songQuery.startsWith("ivr2:") ? songQuery :
        `ivr2:${songQuery.startsWith("/") ? songQuery : `/${songQuery}`}`;
      const downloadUrl = new URL(`${YEMOT_API_BASE}DownloadFile`);
      downloadUrl.searchParams.set("token", `${YEMOT_USERNAME}:${YEMOT_PASSWORD}`);
      downloadUrl.searchParams.set("path", recordedPath);
      const audioResponse = await fetch(downloadUrl);
      const audioBytes = await audioResponse.arrayBuffer();
      if (!audioResponse.ok || !audioBytes.byteLength) {
        console.error("Yemot DownloadFile failed:", audioResponse.status, audioResponse.headers.get("content-type"));
        return res.send("id_list_message=t-לא הצלחתי להוריד את ההקלטה מימות. נסו שוב.");
      }
      // Yemot may return a JSON error with HTTP 200; don't send that to transcription as audio.
      const audioType = audioResponse.headers.get("content-type") || "";
      const firstBytes = Buffer.from(audioBytes).subarray(0, 80).toString("utf8").trimStart();
      if (audioType.includes("application/json") || firstBytes.startsWith("{") || firstBytes.startsWith("<")) {
        console.error("Yemot DownloadFile returned an error payload:", firstBytes.slice(0, 160));
        return res.send("id_list_message=t-ימות לא החזירה קובץ הקלטה תקין.");
      }

      const geminiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  text: "תמלל במדויק את הדיבור בהקלטה בעברית. החזר רק את המילים שנאמרו, בלי הסברים ובלי תוספות."
                },
                {
                  inline_data: {
                    mime_type: "audio/wav",
                    data: Buffer.from(audioBytes).toString("base64")
                  }
                }
              ]
            }],
            generationConfig: { temperature: 0 }
          })
        }
      );
      const geminiData = await geminiResponse.json();
      const transcription = (geminiData.candidates?.[0]?.content?.parts || [])
        .map(part => part.text || "")
        .join(" ")
        .trim();
      if (!geminiResponse.ok || !transcription) {
        const apiError = geminiData.error || {};
        console.error("Gemini transcription failed:", JSON.stringify({
          status: geminiResponse.status,
          statusText: apiError.status || null,
          message: apiError.message || "No transcription text returned"
        }));
        return res.send("id_list_message=t-שגיאת תמלול מספר " + geminiResponse.status + ". בדקו את לוגי Vercel.");
      }
      songQuery = transcription.slice(0, 200);
    }

    if (!YOUTUBE_API_KEY) return res.send("id_list_message=t-מפתח החיפוש לא מוגדר.");
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", songQuery);
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "5");
    url.searchParams.set("regionCode", "IL");
    url.searchParams.set("relevanceLanguage", "he");
    url.searchParams.set("key", YOUTUBE_API_KEY);
    const response = await fetch(url);
    if (!response.ok) return res.send("id_list_message=t-אירעה שגיאה בחיפוש. נסו שוב.");
    const data = await response.json();
    const results = (data.items || []).filter(item => item.id?.videoId).slice(0, 5)
      .map(item => ({ videoId: item.id.videoId, title: cleanForTts(item.snippet?.title) }));
    console.log("YouTube search diagnostics:", JSON.stringify({
      resultCount: results.length,
      hasChoice: Boolean(choice),
      choiceValid: ["1", "2", "3", "4", "5"].includes(choice)
    }));
    if (!results.length) return res.send("id_list_message=t-לא נמצאו תוצאות. נסו שוב.");
    if (choice) {
      const selected = results[Number(choice) - 1];
      if (!selected || !["1", "2", "3", "4", "5"].includes(choice)) {
        return res.send("id_list_message=t-בחירה לא תקינה.");
      }
      // Extract audio through the dedicated yt-dlp worker, then upload it to Yemot.
      if (!process.env.AUDIO_WORKER_URL || !process.env.AUDIO_WORKER_TOKEN) {
        return res.send("id_list_message=t-שירות השמע עדיין לא מוגדר בשרת.");
      }
      if (!YEMOT_USERNAME || !YEMOT_PASSWORD) {
        return res.send("id_list_message=t-חסרים פרטי התחברות לימות.");
      }

      const workerBaseUrl = process.env.AUDIO_WORKER_URL.endsWith("/")
        ? process.env.AUDIO_WORKER_URL.slice(0, -1)
        : process.env.AUDIO_WORKER_URL;
      const workerResponse = await fetch(`${workerBaseUrl}/audio`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Token": process.env.AUDIO_WORKER_TOKEN
        },
        body: JSON.stringify({ videoId: selected.videoId })
      });
      if (!workerResponse.ok) {
        console.error("Audio worker failed:", workerResponse.status);
        return res.send("id_list_message=t-לא הצלחתי להכין את קובץ השמע. נסו שיר אחר.");
      }

      const audioBytes = await workerResponse.arrayBuffer();
      if (!audioBytes.byteLength || audioBytes.byteLength > 45 * 1024 * 1024) {
        return res.send("id_list_message=t-קובץ השמע ריק או גדול מדי.");
      }

      const uploadForm = new FormData();
      uploadForm.set("token", `${YEMOT_USERNAME}:${YEMOT_PASSWORD}`);
      uploadForm.set("path", "ivr2:9/000.wav");
      uploadForm.set("convertAudio", "1");
      uploadForm.set("autoNumbering", "false");
      uploadForm.set("tts", "0");
      uploadForm.set("fileUpload", new Blob([audioBytes], { type: "application/octet-stream" }), "selected-audio.bin");

      const uploadResponse = await fetch(`${YEMOT_API_BASE}UploadFile`, {
        method: "POST",
        body: uploadForm
      });
      const uploadText = await uploadResponse.text();
      let uploadData;
      try { uploadData = JSON.parse(uploadText); } catch { uploadData = null; }
      if (!uploadResponse.ok || (uploadData && uploadData.responseStatus && uploadData.responseStatus !== "OK") || (uploadData && uploadData.messageCode)) {
        console.error("Yemot audio upload failed:", uploadResponse.status, uploadText.slice(0, 300));
        return res.send("id_list_message=t-העלאת השמע לימות נכשלה.");
      }

      // Configure extension 9 in Yemot as type=playfile so it plays /9/000.wav.
      return res.send("go_to_folder=/9");
    }
    const spoken = results.map((item, i) => `אפשרות ${i + 1}. ${item.title}`).join(". ").slice(0, 1200);
    return res.send(`id_list_message=t-${spoken}&read=t-הקישו מספר מאחת עד חמש=CHOICE,,1,1,Digits`);
  } catch (error) {
    console.error("Yemot search handler failed:", error?.message || "unknown error");
    return res.status(200).send("id_list_message=t-אירעה שגיאה בשרת. נסו שוב.");
  }
});

app.get("/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Missing search query"
      });
    }

    if (!YOUTUBE_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "YouTube API key is not configured"
      });
    }

    const url = new URL(
      "https://www.googleapis.com/youtube/v3/search"
    );

    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", query);
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "5");
    url.searchParams.set("regionCode", "IL");
    url.searchParams.set("relevanceLanguage", "he");
    url.searchParams.set("key", YOUTUBE_API_KEY);

    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("YouTube API error:", errorText);

      return res.status(502).json({
        success: false,
        error: "YouTube API request failed"
      });
    }

    const data = await response.json();

    const results = (data.items || []).map((item, index) => ({
      number: index + 1,
      title: item.snippet?.title || "",
      videoId: item.id?.videoId || "",
      channel: item.snippet?.channelTitle || ""
    }));

    res.json({
      success: true,
      query,
      results
    });
  } catch (error) {
    console.error("Server error:", error);

    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
