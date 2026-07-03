const MATCH_SYSTEM_PROMPT = `You are a career intelligence engine. Given a candidate profile and a job description, return a JSON object with exactly these keys:
{
  "role_fit": <0-100 integer>,
  "sector_fit": <0-100 integer>,
  "comp_fit": <0-100 integer or null if salary unknown>,
  "growth_score": <0-100 integer>,
  "overall_score": <0-100 integer>,
  "top_matching_skills": [<up to 5 skill strings from the profile that match the JD>],
  "missing_skills": [<up to 5 skill strings present in JD but absent from profile>],
  "adjacent_titles": [<up to 5 alternative job titles this candidate would qualify for>],
  "recommendation": <one sentence plain-text recommendation>,
  "summary": <two sentence plain-text summary of the fit>
}`;

function buildMatchUserPrompt(job, profile) {
  return `CANDIDATE PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nJOB TITLE: ${job.title}\nCOMPANY: ${job.company}\nLOCATION: ${job.location}\nSALARY: ${job.salary_min ?? "?"} - ${job.salary_max ?? "?"} ${job.salary_interval ?? ""}\n\nJOB DESCRIPTION:\n${job.description_clean?.slice(0, 3000) ?? "(no description)"}`;
}

async function scoreJobWithAI(job, profile, aiJson) {
  return aiJson(MATCH_SYSTEM_PROMPT, buildMatchUserPrompt(job, profile));
}

module.exports = { scoreJobWithAI, MATCH_SYSTEM_PROMPT, buildMatchUserPrompt };
