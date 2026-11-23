import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PersistedRun {
  id: string;
  name: string;
  status: string;
  step: string;
  createdAt: number;
  updatedAt: number;
  coolifyUrl: string;
  dokployUrl: string;
  irJson: string | null;
  credentialsCiphertext: string | null;
  vaultCiphertext: Record<string, string>;
  selectionJson: string | null;
  reportJson: string | null;
  decisionsJson: string | null;
}

export class JsonRunStore {
  private readonly file: string;
  private data: { runs: PersistedRun[] };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "runs.json");
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as {
          runs: PersistedRun[];
        })
      : { runs: [] };
  }

  list(): PersistedRun[] {
    return [...this.data.runs].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): PersistedRun | undefined {
    return this.data.runs.find((run) => run.id === id);
  }

  put(run: PersistedRun): PersistedRun {
    const index = this.data.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) this.data.runs[index] = run;
    else this.data.runs.push(run);
    this.save();
    return run;
  }

  delete(id: string): void {
    this.data.runs = this.data.runs.filter((run) => run.id !== id);
    this.save();
  }

  private save(): void {
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}
