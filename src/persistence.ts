export class SerializedSettingsWriter {
  private running: Promise<void> | null = null;
  private writeAgain = false;

  constructor(private readonly write: () => Promise<void>) {}

  save(): Promise<void> {
    this.writeAgain = true;
    if (!this.running) {
      this.running = (async () => {
        while (this.writeAgain) {
          this.writeAgain = false;
          await this.write();
        }
      })().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }
}
