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


// Yemot IVR flow: record a spoken song query for free, transcribe it externally,
// list 5 search results, then collect a one-digit selection.
app.get("/yemot-search", async (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");

  const cleanForTts = (value) =>
    String(value || "")
      .replace(/[&=<>]/g, " ")
      .replace(/[\\r\\n]+/g, " ")
      .replace(/[“”"']/g, "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 180);

  let songQuery = String(req.query.SONG || "").trim();
  const choice = String(req.query.CHOICE || "").trim();

  // First call: record the caller's words instead of using Yemot's paid voice recognition.
  if (!songQuery) {
    const fileName = `song_${Date.now()}`;
    return res.send(
      `read=t-אנא אמרו את שם השיר או הזמר, ולאחר מכן הקישו סולמית=SONG,,record,/9,${fileName},no,yes`
    );
  }

  // A recorded path (for example /9/123.wav) is transcribed by the external API.
  if (/\\.wav(?:$|\\?)/i.test(songQuery) || /^\\/[^/]+\\//.test(songQuery)) {
    if (!YEMOT_USERNAME || !YEMOT_PASSWORD) {
      return res.send("id_list_message=t-פרטי החיבור לימות לא הוגדרו בשרת.");
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.send("id_list_message=t-שירות התמלול לא הוגדר עדיין בשרת.");
    }

    try {
      const loginBody = new URLSearchParams({
        username: YEMOT_USERNAME,
        password: YEMOT_PASSWORD
      });
      const loginResponse = await fetch(`${YEMOT_API_BASE}Login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: loginBody
      });
      const loginData = await loginResponse.json();
      if (!loginResponse.ok || loginData.responseStatus !== "OK" || !loginData.token) {
        return res.send("id_list_message=t-לא הצלחתי להתחבר לימות כדי לקבל את ההקלטה.");
      }

      const recordedPath = songQuery.startsWith("ivr2:")
        ? songQuery
        : `ivr2:${songQuery.startsWith("/") ? songQuery : `/${songQuery}`}`;
      const downloadUrl = new URL(`${YEMOT_API_BASE}DownloadFile`);
      downloadUrl.searchParams.set("token", loginData.token);
      downloadUrl.searchParams.set("path", recordedPath);
      const audioResponse = await fetch(downloadUrl);

      if (!audioResponse.ok) {
        return res.send("id_list_message=t-לא הצלחתי להוריד את ההקלטה. נסו שוב.");
      }
      const audioBytes = await audioResponse.arrayBuffer();
      if (!audioBytes.byteLength) {
        return res.send("id_list_message=t-ההקלטה ריקה. נסו שוב.");
      }

      const form = new FormData();
      form.append("model", "gpt-4o-mini-transcribe");
      form.append("language", "he");
      form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "song.wav");
      const transcriptionResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form
      });
      const transcription = await transcriptionResponse.json();
      if (!transcriptionResponse.ok || !transcription.text) {
        console.error("External transcription failed:", transcription.error?.message || transcriptionResponse.status);
        return res.send("id_list_message=tלא הצלחתי להבין את ההקלטה. נסו להקליט שוב.");
      }
      songQuery = String(transcription.text).trim().slice(0, 200);
      if (!songQuery) {
        return res.send("id_list_message=t-לא זוהה שם שיר. נסו שוב.");
      }
    } catch (error) {
      console.error("Recording transcription flow failed.");
      return res.send("id_list_message=t-אירעה שגיאה בעיבוד ההקלטה. נסו שוב.");
    }
  }

  if (!YOUTUBE_API_KEY) {
    return res.send("id_list_message=t-שגיאה: מפתח החיפוש לא מוגדר.");
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", songQuery);
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "5");
    url.searchParams.set("regionCode", "IL");
    url.searchParams.set("relevanceLanguage", "he");
    url.searchParams.set("key", YOUTUBE_API_KEY);

    const response = await fetch(url);
    if (!response.ok) {
      return res.send("id_list_message=t-אירעה שגיאה בחיפוש. נסו שוב.");
    }

    const data = await response.json();
    const results = (data.items || [])
      .filter((item) => item.id?.videoId)
      .slice(0, 5)
      .map((item) => ({
        videoId: item.id.videoId,
        title: cleanForTts(item.snippet?.title),
        channel: cleanForTts(item.snippet?.channelTitle)
      }));

    if (!results.length) {
      return res.send("id_list_message=t-לא נמצאו תוצאות. נסו להקליט שוב.");
    }

    if (choice) {
      const selected = results[Number(choice) - 1];
      if (!selected || !["1", "2", "3", "4", "5"].includes(choice)) {
        return res.send(
          "id_list_message=t-בחירה לא תקינה.&read=t-הקישו מספר בין אחת לחמש=CHOICE,,1,1,Digits"
        );
      }
      return res.send(
        `id_list_message=t-בחרתם אפשרות ${choice}. ${selected.title}.&noop=בחירת השיר התקבלה`
      );
    }

    const spokenResults = results
      .map((item, index) => `אפשרות ${index + 1}. ${item.title}`)
      .join(". ")
      .slice(0, 1200);

    return res.send(
      `id_list_message=t-מצאתי תוצאות עבור ${cleanForTts(songQuery)}. ${spokenResults}.&read=t-להשמעת הבחירה הקישו מספר מאחת עד חמש=CHOICE,,1,1,Digits`
    );
  } catch (error) {
    console.error("Yemot search flow failed.");
    return res.send("id_list_message=t-אירעה שגיאה. נסו שוב מאוחר יותר.");
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
