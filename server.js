const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Yemot YouTube Search",
    status: "online"
  });
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
