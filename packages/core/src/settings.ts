/**
 * Workspace settings: brand, personalisation defaults, consent policy,
 * sending limits and tracking preferences. Stored as JSON on the workspace and
 * always parsed through this schema so missing keys get safe defaults.
 */
import { z } from 'zod';
import { WORKSPACE_VARIABLE_KEY_RE } from './template/variables';

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'Use an http(s) link.')
  .default('');

export const workspaceSettingsSchema = z.object({
  companyName: z.string().trim().max(120).default(''),
  /** Postal address shown in marketing footers (required by many anti-spam laws). */
  companyAddress: z.string().trim().max(300).default(''),
  websiteUrl: optionalUrl,
  logoUrl: optionalUrl,
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #4f46e5.')
    .default('#4f46e5'),
  /** Greeting used when a contact has no first name: "Hi there". */
  fallbackFirstName: z.string().trim().max(40).default('there'),
  locale: z.string().max(20).default('en-IN'),
  /** How ambiguous numeric dates in imports are read. */
  dateOrder: z.enum(['DMY', 'MDY', 'YMD']).default('DMY'),
  /** Workspace-level template variables, e.g. collaboration_url, latest_project_name. */
  variables: z
    .record(z.string().regex(WORKSPACE_VARIABLE_KEY_RE), z.string().max(2000))
    .refine((v) => Object.keys(v).length <= 100, 'At most 100 variables.')
    .default({}),
  consent: z
    .object({
      allowImpliedForMarketing: z.boolean().default(false),
      allowUnknownForRelationship: z.boolean().default(false),
    })
    .default({ allowImpliedForMarketing: false, allowUnknownForRelationship: false }),
  sending: z
    .object({
      /** Max marketing + relationship e-mails per contact in a rolling 7 days (0 = unlimited). */
      weeklyCapPerContact: z.number().int().min(0).max(100).default(4),
      /** Max non-transactional e-mails per contact per rolling 24 hours (0 = unlimited). */
      dailyCapPerContact: z.number().int().min(0).max(50).default(2),
      requireCampaignApproval: z.boolean().default(false),
      /** Messages per second across the workspace. */
      ratePerSecond: z.number().min(0.1).max(500).default(10),
    })
    .default({ weeklyCapPerContact: 4, dailyCapPerContact: 2, requireCampaignApproval: false, ratePerSecond: 10 }),
  tracking: z
    .object({
      opens: z.boolean().default(true),
      clicks: z.boolean().default(true),
    })
    .default({ opens: true, clicks: true }),
  dedupe: z
    .object({
      gmailCanonical: z.boolean().default(false),
    })
    .default({ gmailCanonical: false }),
  retention: z
    .object({
      /** Message bodies are cleared after this many days; metadata is kept. */
      messageBodyDays: z.number().int().min(7).max(3650).default(365),
    })
    .default({ messageBodyDays: 365 }),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type WorkspaceSettingsInput = z.input<typeof workspaceSettingsSchema>;

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const result = workspaceSettingsSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  // Corrupt or outdated settings must never block sending decisions; fall back to defaults.
  return workspaceSettingsSchema.parse({});
}
