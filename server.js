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

    // Ignore Yemot's hangup notification instead of treating it as a new call.
    if (String(req.query.hangup || "").toLowerCase() === "yes") {
      return res.send("OK");
    }

    if (!songQuery) {
      const fileName = `song_${Date.now()}`;
      return res.send(
        `read=t-אמרו את שם השיר או הזמר, ולאחר מכן הקישו סולמית=SONG,,record,/9,${fileName},no,yes`
      );
    }

    if (/\.wav(?:$|\?)/i.test(songQuery) || /^\/[^/]+\//.test(songQuery)) {
      if (!YEMOT_USERNAME || !YEMOT_PASSWORD || !process.env.OPENAI_API_KEY) {
        return res.send("id_list_message=t-חסר מפתח תמלול או פרטי חיבור בשרת.");
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
      if (!audioResponse.ok) return res.send("id_list_message=t-לא הצלחתי להוריד את ההקלטה.");
      const audioBytes = await audioResponse.arrayBuffer();
      if (!audioBytes.byteLength) return res.send("id_list_message=t-ההקלטה ריקה. נסו שוב.");

      const form = new FormData();
      form.append("model", "gpt-4o-mini-transcribe");
      form.append("language", "he");
      form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "song.wav");
      const trResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form
      });
      const tr = await trResponse.json();
      if (!trResponse.ok || !tr.text) {
        console.error("Transcription API failed:", tr.error?.message || trResponse.status);
        return res.send("id_list_message=t-לא הצלחתי להבין את ההקלטה. נסו שוב.");
      }
      songQuery = String(tr.text).trim().slice(0, 200);
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
    if (!results.length) return res.send("id_list_message=t-לא נמצאו תוצאות. נסו שוב.");
    if (choice) {
      const selected = results[Number(choice) - 1];
      if (!selected || !["1", "2", "3", "4", "5"].includes(choice)) {
        return res.send("id_list_message=t-בחירה לא תקינה.");
      }
      return res.send(`id_list_message=t-בחרתם אפשרות ${choice}. ${selected.title}`);
    }
    const spoken = results.map((item, i) => `אפשרות ${i + 1}. ${item.title}`).join(". ").slice(0, 1200);
    return res.send(`id_list_message=t-${spoken}.&read=t-הקישו מספר מאחת עד חמש=CHOICE,,1,1,Digits`);
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
