export interface MonitorResult {
  monitor: string;
  healthy: boolean;
  issues: {
    resource: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
  }[];
  checkedAt: Date;
}

export interface Monitor {
  name: string;
  check(): Promise<MonitorResult>;
}
