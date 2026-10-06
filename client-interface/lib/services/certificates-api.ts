import type { CertificateDecision } from '@/lib/utils/certificate-decision';
import type { ReviewStage } from '@/lib/utils/certificate-review-stage';
import { apiClient } from './api-client';

export interface CertificateElement {
  id: string;
  text: string;
  type: 'static' | 'dynamic' | 'badge' | 'image';
  dynamicKey?: 'mentee_name' | 'mentor_name' | 'date_issued' | 'program_name' | 'fellowship_name' | 'issuer_name' | 'issuer_title' | 'tier_name' | 'certificate_number';
  xPercent: number;
  yPercent: number;
  fontSizePercent: number;
  color: string;
  fontWeight: string;
  alignment: 'left' | 'center' | 'right';
  fontStyle?: string;
  widthPercent?: number;
  imageUrl?: string;
  /** A badge element's own artwork, when it does not vary by tier. */
  badgeUrl?: string;

  // ── Tier-aware content ────────────────────────────────────────────────────
  // One certificate design, several outcomes. These two fields let a single
  // element say something different — or nothing at all — depending on which
  // tier the recipient was awarded, so gold and participation can share a
  // layout without becoming two templates that drift apart.

  /**
   * Content keyed by tier id (the ids in `template.criteria`).
   *   text elements  → the string to render for that tier
   *   badge elements → the image URL to render for that tier
   * A tier with no entry here falls back: text to `text`, a badge to that
   * tier's own `criteria[].badgeUrl`. So filling in only the tiers that differ
   * is a valid and normal way to use it.
   */
  tierValues?: Record<string, string>;

  /**
   * Render this element ONLY for these tiers. Absent or empty means every
   * tier, which is what every element written before this field existed means.
   */
  visibleForTiers?: string[];
}

export interface CertificateTemplate {
  id: string;
  name: string;
  bgImageUrl?: string;
  logoUrl?: string;
  logoConfig?: {
    xPercent: number;
    yPercent: number;
    widthPercent: number;
  };
  config: CertificateElement[];
  criteria?: Array<{
    id: string;
    name: string;
    badgeUrl?: string;
    /**
     * This tier's certificate — the whole artwork, not a badge pasted onto a
     * shared background. Each tier is its own design, so the recipient's name,
     * the date and the certificate number are positioned per tier in `layout`
     * rather than once for the template.
     */
    artworkUrl?: string;
    layout?: CertificateElement[];
    keywords?: string[] | null;
    minScorePercent?: number | null;
    maxOpenBlockers?: number | null;
    minCompletionRate?: number | null;
    minOnTimeRate?: number | null;
    minAvgRating?: number | null;
    minAttendanceRate?: number | null;
    customRule?: string | null;
    reviewChecklist?: string[];
  }>;
  aiEvaluation?: { results: AIEvaluationResult[]; ranAt: string } | null;
  aiEvaluationRanAt?: string | null;

  createdBy: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  programId: string;
  program?: {
    id: string;
    name: string;
  };
  creator?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

export interface CertificateInstance {
  id: string;
  templateId: string;
  menteeId: string;
  mentorId?: string;
  issuedBy: string;

  imageUrl?: string;
  tier: string;
  /** The credential's public identity, printed on it and resolvable at /verify. */
  certificateNumber?: string;
  metadata: any;
  template?: CertificateTemplate;
  mentee?: { id: string; firstName: string; lastName: string; email: string };
  mentor?: { id: string; firstName: string; lastName: string };
  issuer?: { id: string; firstName: string; lastName: string };
  createdAt: string;
  updatedAt: string;
}

export interface AIBlockersAnalysis {
  total: number;
  resolved: number;
  open?: number;
  impact: 'Low' | 'Medium' | 'High';
  summary: string;
}

export interface AIEvaluationResult {
  mentee_id: string;
  firstName: string;
  lastName: string;
  email: string;
  is_eligible: boolean;
  certificate_tier: string | null;
  decision?: CertificateDecision;
  match_score: number;        
  overall_percentage: number; 
  completion_rate?: number;
  on_time_rate?: number;
  avg_rating?: number | null;
  matched_keywords: string[];
  missing_keywords: string[];
  hard_constraints_check: {
    score_ok:           boolean;
    blockers_ok:        boolean;
    completion_rate_ok: boolean;
    on_time_rate_ok:    boolean;
    rating_ok:          boolean;
    attendance_ok?:     boolean;
  };
  score_breakdown?: {
    points_pct: number;
    rating_pct: number;
    task_score: number;
    blocker_score: number;
    on_time_pct: number;
    attendance_pct: number | null;
    composite: number;
  };
  cohort_reviews?: {
    total_sessions: number;
    present: number;
    excused: number;
    absent: number;
    attendance_pct: number | null;
    data_available: boolean;
  };
  blockers_analysis?: AIBlockersAnalysis;
  custom_rules_check?: Array<{
    tierId?: string;
    rule: string;
    passed: boolean;
    evidence: string;
  }>;
  criteria_checks?: Array<{
    tierId?: string;
    item: string;
    passed: boolean;
    evidence: string;
  }>;
  tier_checks?: Array<{
    tier_id: string;
    hard_constraints_passed: boolean;
    keywords_passed: boolean;
    missing_keywords: string[];
    custom_rule: string | null;
    custom_rule_passed: boolean;
    custom_rule_evidence: string | null;
    checklist_passed?: boolean;
    checklist?: Array<{ item: string; passed: boolean; evidence: string | null }>;
  }>;
  evaluation_summary?: string;
  reasoning: string;
}


// ── Mentor verification of AI-assigned grades ───────────────────────────────

/** One mentee awaiting (or carrying) a mentor's sign-off on their grade. */
export interface CertificateDecisionHistoryEntry {
  at: string;
  by: string;
  byName?: string;
  from: { decision: CertificateDecision; tier: string | null };
  to: { decision: CertificateDecision; tier: string | null };
  reason: string | null;
}

export interface CertificateVerification {
  id: string;
  menteeId: string;
  mentee: { id: string; firstName: string; lastName: string; email: string; profilePictureUrl?: string } | null;
  clanId: string | null;
  clanName: string | null;
  /** What the AI proposed — kept after an override so the change stays visible. */
  aiTier: string | null;
  aiMatchScore: number | null;
  /** What will actually be issued. */
  finalTier: string | null;
  decision: CertificateDecision;
  aiDecision: CertificateDecision;
  decisionHistory: CertificateDecisionHistoryEntry[];
  overridden: boolean;
  overrideReason: string | null;
  criteriaChecks: string[];
  status: 'pending' | 'verified';
  /** An admin has queried this grade and the mentor has not answered yet. */
  hasOpenQuestion?: boolean;
  /** A mentor has asked to change an admin-approved certificate grade. */
  hasChangeRequest?: boolean;
  /**
   * How far the review has got. `status` cannot distinguish a mentor's check
   * from an admin's approval — both write 'verified' — so this carries the
   * distinction the admin's roster needs. Optional: an older API build does not
   * send it, and `reviewStage()` falls back to `status`.
   */
  stage?: ReviewStage;
  verifiedAt: string | null;
  verifiedBy: string | null;
}

/**
 * An admin asking a mentor to explain a grade, and the mentor's answer.
 *
 * Not a review stage: the grade is untouched while this is open. An admin who
 * disagreed previously had only "accept" or "overrule", and overruling throws
 * away the mentor's reasoning along with their decision.
 */
export interface CertificateReviewQuestion {
  id: string;
  templateId: string;
  menteeId: string;
  menteeName: string | null;
  clanId: string | null;
  clanName: string | null;
  /**
   * Which way this thread runs. A change request is the question thread pointed
   * the other way — mentor to admin — so it shares the shape and the UI.
   */
  kind: 'question' | 'change_request' | 'report_request';
  question: string;
  /** What a change request asks for, so an admin can grant it in one press. */
  requestedTier?: string | null;
  requestedDecision?: 'award' | 'no_certificate' | null;
  /** How the admin decided it. `answer` holds their note either way. */
  resolution?: 'approved' | 'declined' | null;
  askedBy: string | null;
  askedById?: string | null;
  askedAt: string;
  /** The mentor whose decision is in question. */
  addressedTo: string | null;
  addressedToName: string | null;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  status: 'open' | 'answered' | 'withdrawn';
}

/** A certificate that went out with no signed-off grade behind it. */
export interface UnreviewedIssuedCertificate {
  instanceId: string;
  menteeId: string;
  menteeName: string | null;
  menteeEmail: string | null;
  clanId: string | null;
  clanName: string | null;
  tier: string;
  certificateNumber: string | null;
  issuedAt: string;
  /** null when the mentee has no review row at all. */
  reviewStatus: 'pending' | 'verified' | null;
  reviewStage: ReviewStage | null;
}

/** Per-clan progress through the review round — what the admin's banner shows. */
export interface VerificationClanStatus {
  clanId: string | null;
  clanName: string;
  total: number;
  verified: number;
  pending: number;
  overridden: number;
  changeRequests?: number;
  noCertificate?: number;
  /** Verified by a mentor, still waiting on the admin. */
  mentorVerified?: number;
  /** The admin's own approvals — what they have personally cleared. */
  adminApproved?: number;
  complete: boolean;
  /** The admin has approved this clan's reviewed grades. */
  approved: boolean;
  /** Verified by mentors but not yet approved by an admin: the admin's move. */
  readyToApprove: boolean;
}

/** A clan's state inside one mentor's review queue. */
export interface ReviewerClanState {
  clanId: string;
  clanName: string | null;
  total: number;
  pending: number;
  verified: number;
  overridden: number;
  noCertificate: number;
  complete: boolean;
  /** The admin has released this clan. */
  approved: boolean;
  /** Whether this mentor may send certificates for the clan. */
  canSend: boolean;
}

export interface VerificationSummary {
  deadline: string | null;
  /** The deadline has passed AND work is outstanding. Never blocks issuing. */
  overdue: boolean;
  total: number;
  verified: number;
  pending: number;
  overridden: number;
  noCertificate?: number;
  allVerified: boolean;
  /** Verified by a mentor and still waiting on an admin. */
  mentorVerified?: number;
  /** Approved by an admin — the step that releases anything. */
  adminApproved?: number;
  /** Queried by an admin, awaiting the mentor's answer. */
  questioned?: number;
  /** Approved grades a mentor has asked to change, awaiting an admin. */
  changeRequested?: number;
  /** Clans whose mentor has asked for the certificate report. */
  reportRequests?: number;
  /** Clans the admin has released for issuing. */
  approvedClans: number;
  /** Verified but not yet released — waiting on the admin. */
  awaitingApproval: number;
  clans: VerificationClanStatus[];
}

// ── "Why this certificate?" — one mentee's whole case ───────────────────────

/** What the record says about a mentee today, recomputed on every read. */
export interface MenteeMetrics {
  mentee_id: string;
  clan_id: string | null;
  clan_name: string | null;
  normalized_score: number;
  /** Progress through the ROADMAP — see `completion_basis` for the sum. */
  completion_rate: number;
  on_time_rate: number;
  avg_rating: number | null;
  total_tasks: number;
  completed_tasks: number;
  /** Which denominator `completion_rate` used, and the counts behind it. */
  completion_basis?: {
    basis: 'roadmap' | 'all_assigned';
    counted_total: number;
    counted_completed: number;
    roadmap_total: number;
    roadmap_completed: number;
    custom_total: number;
    custom_completed: number;
  };
  score_breakdown: {
    points_pct: number;
    rating_pct: number;
    task_score: number;
    blocker_score: number;
    on_time_pct: number;
    attendance_pct: number | null;
    composite: number;
  };
  blockers: {
    total: number;
    resolved: number;
    open: number;
    open_by_severity?: Record<string, number>;
    categories?: string[];
  };
  cohort_reviews: {
    total_sessions: number;
    present: number;
    excused: number;
    absent: number;
    attendance_pct: number | null;
    data_available: boolean;
  };
  tasks?: EvidenceTask[];
}

/** One assigned task, as proof of work. */
export interface EvidenceTask {
  title: string;
  description?: string | null;
  status: string;
  type: string;
  difficulty: string;
  isCustomTask: boolean;
  isLate: boolean;
  rating: number | null;
  pointsPct?: number | null;
  roadmapId?: string | null;
  roadmapName?: string | null;
  taskOrder?: number | null;
  dueDate?: string | null;
}

/** A roadmap the mentee was set, and how far through it they are. */
export interface EvidenceRoadmap {
  id: string | null;
  name: string;
  total: number;
  completed: number;
  remaining: number;
  late: number;
  percent: number;
  tasks: EvidenceTask[];
}

/** One tier's thresholds, as configured on the template. */
export interface TierThresholds {
  id: string;
  name: string;
  minScorePercent: number | null;
  maxOpenBlockers: number | null;
  minCompletionRate: number | null;
  minOnTimeRate: number | null;
  minAvgRating: number | null;
  minAttendanceRate: number | null;
  reviewChecklist: string[];
}

export interface TierConstraintChecks {
  score_ok: boolean;
  blockers_ok: boolean;
  completion_rate_ok: boolean;
  on_time_rate_ok: boolean;
  rating_ok: boolean;
  attendance_ok: boolean;
}

export interface MenteeEvidence {
  mentee: { id: string; firstName: string; lastName: string; email: string; profilePictureUrl?: string | null };
  clan: { id: string; name: string } | null;
  criteria: TierThresholds[];
  metrics: MenteeMetrics;
  /** The work itself, grouped by the roadmap it came from. */
  roadmaps: EvidenceRoadmap[];
  constraints: {
    /** The highest tier whose hard thresholds this mentee actually clears. */
    maxEligibleTier: string | null;
    hardChecks: Record<string, TierConstraintChecks>;
  };
  /** What the AI proposed, when it has been run. One input, not the answer. */
  ai: AIEvaluationResult | null;
  /** What a mentor decided — and, when they overruled the AI, why. */
  verification: {
    status: 'pending' | 'verified';
    stage?: ReviewStage;
    aiTier: string | null;
    aiMatchScore: number | null;
    finalTier: string | null;
    decision: CertificateDecision;
    aiDecision: CertificateDecision;
    decisionHistory: CertificateDecisionHistoryEntry[];
    overridden: boolean;
    overrideReason: string | null;
    criteriaChecks: string[];
    verifiedAt: string | null;
    verifiedBy: string | null;
  } | null;
  issued: { id: string; tier: string; certificateNumber: string | null; issuedAt: string } | null;
}

export const certificatesApi = {

  /**
   * Why one mentee is getting the certificate they are getting: live metrics,
   * how they measure against each tier, the AI's opinion, and any mentor
   * override with its reason. Scoped server-side.
   */
  getMenteeEvidence: (templateId: string, menteeId: string) =>
    apiClient.get<{ success: boolean; data: MenteeEvidence }>(
      `/certificates/templates/${templateId}/mentees/${menteeId}/evidence`
    ),

  // ── Verification round ────────────────────────────────────────────────────

  /** The mentees this user must sign off on. Scoped to their clans server-side. */
  listVerifications: (templateId: string, clanId?: string) => {
    const qs = clanId ? `?clanId=${encodeURIComponent(clanId)}` : '';
    return apiClient.get<{
      success: boolean;
      data: {
        template: { id: string; name: string; criteria: CertificateTemplate['criteria']; verificationDeadline: string | null };
        rows: CertificateVerification[];
        clans: ReviewerClanState[];
      };
    }>(`/certificates/templates/${templateId}/verifications${qs}`);
  },

  /**
   * Confirm or change one mentee's grade. Omit `finalTier` to accept the AI's.
   * A different tier is an override and the server requires a reason.
   */
  verifyOne: (templateId: string, menteeId: string, body: { decision?: CertificateDecision; finalTier?: string | null; reason?: string; criteriaChecks?: string[] }) =>
    apiClient.post<{ success: boolean; data: { verification: CertificateVerification } }>(
      `/certificates/templates/${templateId}/verifications/${menteeId}`, body
    ),

  /** Sign off several at once — "these all look right". */
  verifyMany: (templateId: string, decisions: Array<{ menteeId: string; decision?: CertificateDecision; finalTier?: string | null; reason?: string; criteriaChecks?: string[] }>) =>
    apiClient.post<{ success: boolean; message: string; data: { verified: number } }>(
      `/certificates/templates/${templateId}/verifications/bulk`, { decisions }, { timeout: 120000 }
    ),

  /**
   * Record admin approval for a clan's reviewed grades. Approval locks mentor
   * edits and enables the mentor to send the finalized certificates.
   */
  approveClan: (templateId: string, clanId: string, note?: string) =>
    apiClient.post<{ success: boolean; message: string; data: { approvedBeforeVerified: boolean; outstandingAtApproval: number } }>(
      `/certificates/templates/${templateId}/clans/${clanId}/approve`, { note }
    ),

  /** Withdraw a clan's release — nothing more can be sent for it. */
  revokeClanApproval: (templateId: string, clanId: string) =>
    apiClient.delete<{ success: boolean; message: string }>(
      `/certificates/templates/${templateId}/clans/${clanId}/approve`
    ),

  /** Per-clan progress, for the admin banner. */
  getVerificationSummary: (templateId: string) =>
    apiClient.get<{ success: boolean; data: VerificationSummary }>(
      `/certificates/templates/${templateId}/verification-summary`
    ),

  /**
   * Hand the graded mentees to their clans' mentors for sign-off, with a
   * deadline. Explicit rather than automatic: an admin usually re-runs the AI
   * while tuning the criteria, and notifying on every run is noise.
   */
  sendToClans: (templateId: string, body: {
    deadline?: string;
    clanIds?: string[];
    menteeIds?: string[];
    assignments?: Array<{ menteeId: string; decision: CertificateDecision; finalTier: string | null; reason?: string }>;
  } = {}) =>
    apiClient.post<{
      success: boolean;
      message: string;
      data: { created: number; updated: number; notified: number; deadline: string };
    }>(`/certificates/templates/${templateId}/send-to-clans`, body, { timeout: 120000 }),

  /** Re-notify mentors, optionally moving the deadline. */
  remindReviewers: (templateId: string, deadline?: string) =>
    apiClient.post<{ success: boolean; message: string; data: { notified: number } }>(
      `/certificates/templates/${templateId}/verifications-remind`, { deadline }
    ),

  /** Resolve a certificate number. Public — no auth, used by /verify. */
  verifyCertificateNumber: (number: string) =>
    apiClient.get<{
      success: boolean;
      data: {
        valid: boolean;
        certificateNumber?: string;
        recipientName?: string | null;
        tier?: string;
        tierName?: string;
        programName?: string | null;
        templateName?: string | null;
        issuedAt?: string;
      };
    }>(`/public/verify/${encodeURIComponent(number)}`),

  listTemplates: (programId?: string) => {
    const qs = new URLSearchParams();
    if (programId) qs.set('programId', programId);
    return apiClient.get<{ success: boolean; data: CertificateTemplate[] }>(`/certificates/templates?${qs.toString()}`);
  },
    
  getTemplate: (id: string) => 
    apiClient.get<{ success: boolean; data: CertificateTemplate }>(`/certificates/templates/${id}`),
    
  createTemplate: (data: Partial<CertificateTemplate>) => 
    apiClient.post<{ success: boolean; data: CertificateTemplate }>('/certificates/templates', data),
    
  updateTemplate: (id: string, data: Partial<CertificateTemplate>) => 
    apiClient.put<{ success: boolean; data: CertificateTemplate }>(`/certificates/templates/${id}`, data),
    
  deleteTemplate: (id: string) => 
    apiClient.delete<{ success: boolean }>(`/certificates/templates/${id}`),

  uploadAsset: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.post<{ success: boolean; url?: string; data?: { url: string } }>('/certificates/upload', formData);
    const url = res.url || res.data?.url || '';
    return { ...res, url };
  },

  getQualification: (id: string, params: { mentorId?: string; programId?: string }) => {
    const qs = new URLSearchParams();
    if (params.mentorId)  qs.set('mentorId', params.mentorId);
    if (params.programId) qs.set('programId', params.programId);
    qs.set('_t', Date.now().toString());
    return apiClient.get<{
      success: boolean;
      data: {
        [tierId: string]: Array<{
          id: string; firstName: string; lastName: string; email: string;
          completedCount: number; totalTasks: number; criteriaMatch: number;
          assignedTier?: string;
          tierMatches?: Record<string, number>;
        }>;
      };
      criteriaTasks?: Array<{ id: string; title: string }>;
    }>(`/certificates/templates/${id}/qualification?${qs.toString()}`, { timeout: 120000 });
  },

  sendToMentors: (templateId: string, programId: string) =>
    apiClient.post<{ success: boolean; message: string; sent: number }>(
      `/certificates/templates/${templateId}/send-to-mentors`, { programId }, { timeout: 120000 }
    ),

  issueCertificates: (data: { 
    templateId: string; 
    menteeIds?: string[]; 
    mentorId?: string; 
    tier?: string;
    recipients?: Array<{ menteeId: string; tier: string }>;
    /** Admin-only, explicit acknowledgement that the selected tier bypasses mentor review. */
    adminOverrideReview?: boolean;
  }) => 
    apiClient.post<{
      success: boolean;
      message: string;
      data: {
        instances: Array<{ id: string; menteeId: string }>;
        /** Actually issued. */
        count: number;
        /** Recipients skipped because they already hold a certificate or have a No certificate decision. */
        skipped: number;
        skippedNoCertificate?: number;
        reviewBypassed?: number;
        /** True when every recipient was already issued, so nothing was sent. */
        alreadyIssued?: boolean;
      };
    }>('/certificates/instances', data, { timeout: 120000 }),
    
  listMenteeCertificates: (menteeId: string) => 
    apiClient.get<{ success: boolean; data: CertificateInstance[] }>(`/certificates/instances/mentee/${menteeId}`),
    
  getCertificateInstance: (id: string) => 
    apiClient.get<{ success: boolean; data: CertificateInstance }>(`/certificates/instances/${id}`),

  getTemplateHistory: (id: string) =>
    apiClient.get<{
      success: boolean;
      data: Array<{
        id:        string;
        tier:      string;
        createdAt: string;
        status:    'issued';
        recipient: { id: string; firstName: string; lastName: string; email: string; role: string } | null;
        issuedBy:  { id: string; firstName: string; lastName: string; email: string; role: string } | null;
      }>;
    }>(`/certificates/templates/${id}/history`),


  deleteCertificateInstance: (id: string) =>
    apiClient.delete<{ success: boolean; message: string }>(`/certificates/instances/${id}`),

  resendCertificateInstance: (id: string) =>
    apiClient.post<{ success: boolean; message: string }>(`/certificates/instances/${id}/resend`),

  revokeAllTemplateCertificates: (id: string) =>
    apiClient.delete<{ success: boolean; message: string }>(`/certificates/templates/${id}/instances`),

  /**
   * The certificates this template issued that nobody signed off. Read-only, so
   * the admin sees who is affected before deciding.
   */
  unreviewedIssued: (id: string) =>
    apiClient.get<{ success: boolean; data: { count: number; certificates: UnreviewedIssuedCertificate[] } }>(
      `/certificates/templates/${id}/unreviewed-issued`),

  /**
   * Take just those back. Distinct from revokeAllTemplateCertificates, which
   * destroys every certificate the template issued — no use when most of them
   * were signed off correctly.
   */
  /** Questions on a template — optionally one mentee's thread, or open only. */
  listReviewQuestions: (templateId: string, params: { menteeId?: string; openOnly?: boolean } = {}) =>
    apiClient.get<{ success: boolean; data: { questions: CertificateReviewQuestion[]; count: number } }>(
      `/certificates/templates/${templateId}/questions`, { params }),

  /** Ask the mentor why they gave this grade. Only valid on a mentor's decision. */
  askMentorAboutGrade: (templateId: string, menteeId: string, question: string) =>
    apiClient.post<{ success: boolean; message: string; data: { question: CertificateReviewQuestion } }>(
      `/certificates/templates/${templateId}/verifications/${menteeId}/question`, { question }),

  answerReviewQuestion: (questionId: string, answer: string) =>
    apiClient.post<{ success: boolean; message: string; data: { question: CertificateReviewQuestion } }>(
      `/certificates/questions/${questionId}/answer`, { answer }),

  /** A mentor asking an admin to revoke an issued certificate and change its grade. */
  requestGradeChange: (templateId: string, menteeId: string, body: { finalTier?: string | null; decision?: string; reason: string }) =>
    apiClient.post<{ success: boolean; message: string; data: { request: CertificateReviewQuestion } }>(
      `/certificates/templates/${templateId}/verifications/${menteeId}/change-request`, body),

  /** Approving revokes the old credential and applies the requested grade. */
  resolveChangeRequest: (questionId: string, approve: boolean, note?: string) =>
    apiClient.post<{ success: boolean; message: string; data: { request: CertificateReviewQuestion } }>(
      `/certificates/questions/${questionId}/resolve`, { approve, note }),

  /** A mentor asking an admin for the certificate report for their clan. */
  requestCertificateReport: (templateId: string, body: { clanId?: string | null; note?: string } = {}) =>
    apiClient.post<{ success: boolean; message: string; data: { request: CertificateReviewQuestion } }>(
      `/certificates/templates/${templateId}/report-request`, body),

  withdrawReviewQuestion: (questionId: string) =>
    apiClient.delete<{ success: boolean; message: string }>(`/certificates/questions/${questionId}`),

  /** Chase one mentee's mentors instead of every unfinished clan. */
  notifyMentorsForMentee: (templateId: string, menteeId: string, note?: string) =>
    apiClient.post<{ success: boolean; message: string; data: { notified: number; clanName: string | null } }>(
      `/certificates/templates/${templateId}/verifications/${menteeId}/notify-mentor`, { note }),

  revokeUnreviewed: (id: string) =>
    apiClient.delete<{ success: boolean; message: string; data: { revoked: number } }>(
      `/certificates/templates/${id}/unreviewed-issued`),

  resendAllTemplateCertificates: (id: string, failedOnly: boolean) =>
    apiClient.post<{ success: boolean; message: string; updated: number }>(`/certificates/templates/${id}/resend`, { failedOnly }),

  runAIEvaluation: (id: string, mentorId?: string, menteeIds?: string[]) => {
    const qs = mentorId ? `?mentorId=${encodeURIComponent(mentorId)}` : '';
    return apiClient.post<{ success: boolean; runId: string; total: number; message: string }>(
      `/certificates/templates/${id}/ai-evaluate${qs}`,
      { menteeIds },
      { timeout: 120000 }
    );
  },

  getAIEvaluationStatus: (id: string, runId?: string) => {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : '';
    return apiClient.get<{
      success: boolean;
      runId: string | null;
      isDone: boolean;
      total: number;
      completed: number;
      failed: number;
      pending: number;
      data: AIEvaluationResult[];
      ranAt: string | null;
    }>(`/certificates/templates/${id}/ai-evaluate/status${qs}`, { timeout: 60000 });
  }
};
