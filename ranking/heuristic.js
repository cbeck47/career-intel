function normalizeText(value) {
  return String(value ?? "").toLowerCase().trim();
}

function significantWords(text) {
  return normalizeText(text)
    .split(/\W+/)
    .filter((word) => word.length > 2);
}

function titleSimilarity(jobTitle, candidateTitle) {
  const job = normalizeText(jobTitle);
  const target = normalizeText(candidateTitle);
  if (!job || !target) return 0;
  if (job.includes(target) || target.includes(job)) return 1;

  const targetWords = significantWords(target);
  if (!targetWords.length) return 0;
  const hits = targetWords.filter((word) => job.includes(word)).length;
  return hits / targetWords.length;
}

function scoreSkillOverlap(job, skills) {
  const text = normalizeText(`${job.title} ${job.description_clean}`);
  if (!skills.length || !text) return 0;

  let matched = 0;
  for (const skill of skills) {
    const normalizedSkill = normalizeText(skill);
    if (normalizedSkill.length > 1 && text.includes(normalizedSkill)) {
      matched += 1;
    }
  }
  return matched / skills.length;
}

function scoreTitleMatch(job, profile, discoverResult) {
  const candidates = [
    ...(profile.preferences?.target_titles ?? []),
    profile.headline,
    ...(discoverResult?.adjacent_roles ?? []).map((role) => role.title),
  ].filter(Boolean);

  if (!candidates.length) return 0;
  return Math.max(...candidates.map((title) => titleSimilarity(job.title, title)));
}

function scoreSector(job, profile) {
  const sectors = (profile.preferences?.target_sectors ?? [])
    .map((sector) => normalizeText(sector))
    .filter(Boolean);
  if (!sectors.length) return 0.5;
  return sectors.includes(normalizeText(job.sector)) ? 1 : 0;
}

function scoreRemote(job, profile) {
  const pref = normalizeText(profile.preferences?.remote ?? "any");
  if (pref === "any") return 0.5;
  if (pref === "remote") return job.remote ? 1 : 0;
  if (pref === "onsite") return job.remote ? 0 : 1;
  if (pref === "hybrid") return job.remote ? 0.7 : 1;
  return 0.5;
}

function scoreSalary(job, profile) {
  const target = profile.preferences?.target_comp?.base;
  const max = job.salary_max ?? job.salary_min;
  if (!target || !max) return 0.5;

  const low = target * 0.8;
  const high = target * 1.2;
  if (max >= low && max <= high) return 1;
  if (max >= target * 0.6 && max <= target * 1.4) return 0.6;
  return 0.2;
}

function scoreLocation(job, profile) {
  const profileLocation = normalizeText(profile.location);
  const jobLocation = normalizeText(job.location);
  if (!profileLocation || !jobLocation) return 0.5;
  if (jobLocation.includes(profileLocation) || profileLocation.includes(jobLocation)) {
    return 1;
  }

  const profileParts = profileLocation.split(",").map((part) => part.trim()).filter(Boolean);
  return profileParts.some((part) => part.length > 2 && jobLocation.includes(part)) ? 0.8 : 0;
}

function computeHeuristicScore(job, profile, discoverResult) {
  const skills = profile.skills ?? [];
  const components = {
    skills: scoreSkillOverlap(job, skills),
    title: scoreTitleMatch(job, profile, discoverResult),
    sector: scoreSector(job, profile),
    remote: scoreRemote(job, profile),
    salary: scoreSalary(job, profile),
    location: scoreLocation(job, profile),
  };

  const weighted =
    components.skills * 0.40 +
    components.title * 0.25 +
    components.sector * 0.10 +
    components.remote * 0.10 +
    components.salary * 0.10 +
    components.location * 0.05;

  const score = Math.round(Math.min(100, Math.max(0, weighted * 100)));
  return { score, components };
}

function rankJobs(jobs, profile, discoverResult) {
  return jobs
    .map((job) => {
      const { score, components } = computeHeuristicScore(job, profile, discoverResult);
      return {
        ...job,
        heuristic_score: score,
        heuristic_components: components,
      };
    })
    .sort((a, b) => b.heuristic_score - a.heuristic_score);
}

module.exports = { rankJobs, computeHeuristicScore };
