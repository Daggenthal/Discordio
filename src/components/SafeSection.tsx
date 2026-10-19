import { Component, ReactNode } from "react";
import { note } from "../lib/diag";

// Catches render errors in one QAM section so a bug there shows a short
// message instead of replacing the whole plugin with Decky's error screen.
export class SafeSection extends Component<{ name: string; children?: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }

  componentDidCatch(e: unknown) {
    note(`${this.props.name} section`, false, e instanceof Error ? e.message : String(e));
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ fontSize: "11px", color: "#ff6b6b", padding: "4px 16px", wordBreak: "break-word" }}>
          {this.props.name} hit an error: {this.state.error}
        </div>
      );
    }
    return this.props.children ?? null;
  }
}
