const { z } = require("zod");

const matchJobSchema = z.object({
  role_fit: z.number().int().min(0).max(100),
  sector_fit: z.number().int().min(0).max(100),
  comp_fit: z.number().int().min(0).max(100).nullable(),
  growth_score: z.number().int().min(0).max(100),
  overall_score: z.number().int().min(0).max(100),
  top_matching_skills: z.array(z.string()).max(5),
  missing_skills: z.array(z.string()).max(5),
  adjacent_titles: z.array(z.string()).max(5),
  recommendation: z.string(),
  summary: z.string(),
});

module.exports = { matchJobSchema };
