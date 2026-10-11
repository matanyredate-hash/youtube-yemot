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
