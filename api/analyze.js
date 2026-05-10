export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { url, depth, extras } = await req.json();

    if (!url) {
      return new Response(JSON.stringify({ error: 'No URL provided' }), { status: 400 });
    }

    const RAPID_KEY = process.env.RAPIDAPI_KEY;
    const GEMINI_KEY = process.env.GEMINI_KEY;

    let videoData = { title: '', description: '', transcript: '', platform: '' };

    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    const isTikTok = url.includes('tiktok.com');

    // ── YOUTUBE ──
    if (isYouTube) {
      videoData.platform = 'YouTube';

      // Extract video ID
      let videoId = '';
      const ytMatch = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (ytMatch) videoId = ytMatch[1];

      if (videoId) {
        // Get transcript
        try {
          const tRes = await fetch(
            `https://youtube-transcript3.p.rapidapi.com/api/transcript?videoId=${videoId}`,
            { headers: { 'X-RapidAPI-Key': RAPID_KEY, 'X-RapidAPI-Host': 'youtube-transcript3.p.rapidapi.com' } }
          );
          const tData = await tRes.json();
          if (tData?.transcript) {
            videoData.transcript = tData.transcript.map(t => t.text).join(' ').slice(0, 3000);
          }
        } catch (e) { /* transcript optional */ }

        // Get metadata
        try {
          const mRes = await fetch(
            `https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${videoId}`,
            { headers: { 'X-RapidAPI-Key': RAPID_KEY, 'X-RapidAPI-Host': 'youtube-media-downloader.p.rapidapi.com' } }
          );
          const mData = await mRes.json();
          videoData.title = mData?.title || '';
          videoData.description = (mData?.description || '').slice(0, 500);
        } catch (e) { /* metadata optional */ }
      }
    }

    // ── TIKTOK ──
    if (isTikTok) {
      videoData.platform = 'TikTok';
      try {
        const tRes = await fetch(
          `https://tiktok-download-without-watermark.p.rapidapi.com/analysis?url=${encodeURIComponent(url)}&hd=0`,
          { headers: { 'X-RapidAPI-Key': RAPID_KEY, 'X-RapidAPI-Host': 'tiktok-download-without-watermark.p.rapidapi.com' } }
        );
        const tData = await tRes.json();
        videoData.title = tData?.data?.title || tData?.data?.desc || '';
        videoData.description = JSON.stringify({
          author: tData?.data?.author?.nickname || '',
          likes: tData?.data?.digg_count || '',
          comments: tData?.data?.comment_count || '',
          shares: tData?.data?.share_count || '',
          duration: tData?.data?.duration || '',
          music: tData?.data?.music?.title || '',
          musicAuthor: tData?.data?.music?.author || '',
          hashtags: (tData?.data?.hashtags || []).map(h => h.name).join(', ')
        });
      } catch (e) { /* handle below */ }
    }

    // ── BUILD PROMPT ──
    const depthMap = {
      full: 'Provide a comprehensive full analysis with all sections.',
      quick: 'Provide only the RECREATION PROMPT block — skip the detailed breakdown.',
      script: 'Focus deeply on script, narration, hook phrasing. Include other sections briefly.',
      visual: 'Focus deeply on visual style, editing pace, color grading. Include other sections briefly.'
    };

    const extrasNote = extras?.length
      ? `Also include detailed subsections for: ${extras.join(', ')}.`
      : '';

    const contextBlock = [
      videoData.title && `TITLE: ${videoData.title}`,
      videoData.description && `METADATA: ${videoData.description}`,
      videoData.transcript && `TRANSCRIPT: ${videoData.transcript}`,
    ].filter(Boolean).join('\n\n');

    const geminiPrompt = `You are an expert video content strategist who reverse engineers viral ${videoData.platform || 'social media'} videos into detailed, actionable recreation prompts.

VIDEO URL: ${url}

${contextBlock || 'No metadata could be extracted — analyze based on URL context and provide best possible reverse-engineered breakdown.'}

Reverse engineer this video and produce a structured recreation guide with these exact sections:

1. HOOK ANALYSIS — First 3 seconds: what grabs attention, visual or spoken opener
2. CONTENT FORMAT — Talking head / faceless / tutorial / POV / storytime / listicle etc.
3. SCRIPT & NARRATION — Tone, pacing, sentence length, vocabulary, energy
4. VISUAL STYLE — Aesthetic, color grading, lighting, text overlays, fonts
5. EDITING PACE — Cut frequency, transitions, speed ramps, effects
6. AUDIO — Music genre/mood, voiceover style, sound design
7. VIDEO STRUCTURE — Breakdown with approximate timestamps
8. RECREATION PROMPT — A single copy-pasteable prompt to recreate this video on a different topic

${depthMap[depth] || depthMap.full}
${extrasNote}

Be specific and actionable.`;

    // ── CALL GEMINI ──
    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
        })
      }
    );

    const gData = await gRes.json();
    if (gData.error) throw new Error(gData.error.message);

    const result = gData.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';

    return new Response(JSON.stringify({ result, platform: videoData.platform, title: videoData.title }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Something went wrong' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
