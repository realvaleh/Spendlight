export type ModelPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
};

export type BudgetLimit = {
  softUsd: number | null;
  hardUsd: number | null;
};

/** `lifetime` sums the whole ledger. `day`, `week`, and `month` sum the current calendar window in `timezone`. */
export type BudgetPeriod = "lifetime" | "day" | "week" | "month";

export type Config = {
  host: string;
  port: number;
  dbPath: string;
  configPath: string | null;
  upstreamBaseUrl: string;
  upstreamApiKey: string | null;
  budgets: {
    global: BudgetLimit;
    projects: Record<string, BudgetLimit>;
    period: BudgetPeriod;
    /** IANA zone used when period is `day`, `week`, or `month`. `UTC` when unset. */
    timezone: string;
  };
  pricing: Record<string, ModelPrice>;
  fallbackPrice: ModelPrice;
};

export type LedgerRow = {
  id: string;
  createdAt: string;
  project: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  status: number;
  error: string | null;
  upstreamId: string | null;
  path: string;
  streamed: number;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
};

export type BudgetDecision = {
  allowed: boolean;
  status: "ok" | "soft" | "hard";
  project: string;
  projectSpend: number;
  globalSpend: number;
  projectLimit: BudgetLimit;
  globalLimit: BudgetLimit;
  message: string | null;
  triggeredBy: "project" | "global" | null;
  period: BudgetPeriod;
  timezone: string;
  /** Inclusive UTC start of the calendar window. Null when period is lifetime. */
  windowStart: string | null;
  /** Exclusive UTC end of the calendar window. Null when period is lifetime. */
  windowEnd: string | null;
};

export type Summary = {
  generatedAt: string;
  /**
   * Set when the summary is limited to one project tag.
   * Null is the full ledger. An empty string is a rejected query (matches nothing).
   */
  scopeProject: string | null;
  /**
   * Set when the summary is limited to one upstream model id.
   * Null is every model. An empty string is a rejected query (matches nothing).
   */
  scopeModel: string | null;
  /**
   * Model-scoped spend inside the calendar window (AND the project when one is set).
   * Null when the summary is not model-scoped, or the budget period is lifetime.
   */
  scopeWindowSpend: number | null;
  spendUsd: number;
  requests: number;
  tokens: number;
  budget: BudgetDecision;
  byProject: { project: string; spendUsd: number; requests: number; tokens: number }[];
  byModel: { model: string; spendUsd: number; requests: number; tokens: number }[];
  daily: { day: string; spendUsd: number; requests: number }[];
  recent: LedgerRow[];
  events: { createdAt: string; type: string; project: string; message: string }[];
};
