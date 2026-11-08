import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const recommendationSchema = z.object({
  responder_id: z.string().regex(UUID).nullable().default(null),
  eta_minutes: z.number().int().min(0).max(1440).nullable().default(null),
  equipment: z.array(z.string().min(1).max(60)).max(6).default([]),
  facility: z.object({ kind: z.string().min(1).max(30), name: z.string().min(1).max(120), distance_km: z.number().min(0).max(5000) }).nullable().default(null),
  victim_message: z.string().max(240).default(''),
  notes: z.string().max(300).default(''),
});

export const assessmentSchema = z.object({
  summary: z.string().min(1).max(280),
  urgency_delta: z.number().finite(), // clamped to [-15, 15] by the scorer
  confidence: z.enum(['low', 'medium', 'high']),
  evidence: z.array(z.object({ source: z.string().min(1).max(60), finding: z.string().min(1).max(200) })).max(8).default([]),
  risks: z.array(z.string().min(1).max(200)).max(5).default([]),
  recommendation: recommendationSchema,
});
export type Assessment = z.infer<typeof assessmentSchema>;

export const submitSchema = assessmentSchema;
