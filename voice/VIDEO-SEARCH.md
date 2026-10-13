# Video search results

`GEMINI_VIDEO_GOOGLE_SEARCH=true` enables Google Search only for the Gemini video specialist. It requires the existing HTTPS desktop gateway origin. Default is off; Luna and other provider roles are unchanged.

A search-used answer is not returned to Luna. Instead, the owner receives a short-lived result-only bearer link with the original escaped Gemini answer and the API-provided Search Suggestions markup, unchanged. Possession grants access, not verified owner identity. The 120-second page sets no cookies and cannot use scripts, connect to APIs, load frames, or be framed. Token hashes alone are retained. Links are redacted from persisted history. Missing or unsupported Suggestions produce an honest display error, never a paraphrased answer.

Enabling Search does not prove it was used. Followups ask a fresh question and get fresh search evidence. No search means no page. Provider-generated claims of searching without reported grounding evidence are unverified.

Official standard prices checked October 13, 2026 are $0.30/M input tokens and $2.50/M output tokens. Paid-tier Search has a shared 5,000-query monthly allowance, then $14/1,000 executed queries. Account eligibility, remaining allowance and actual charges are unknown.

Sources are https://ai.google.dev/gemini-api/docs/google-search, https://ai.google.dev/api/interactions-api, https://ai.google.dev/gemini-api/docs/pricing and https://ai.google.dev/gemini-api/terms.

The two authorized live checks consumed one generation each. TikTok returned video evidence but no reported Search use. YouTube's streamed grounding test failed. Documented search-start and final-output parsing was corrected afterward and tested offline; no paid retest was performed. Real successful grounding presentation therefore remains unverified.
