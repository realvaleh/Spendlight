export type ModelPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
};

export type BudgetLimit = {
  softUsd: number | null;
  hardUsd: number | null;
};

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
};

export type Summary = {
  generatedAt: string;
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
