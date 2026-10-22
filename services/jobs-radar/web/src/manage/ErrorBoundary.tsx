import { Component, type ReactNode } from "react";
import { Button, Card } from "@heroui/react";
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="max-w-xl mx-auto p-8">
        <Card>
          <Card.Header>
            <Card.Title>页面加载失败</Card.Title>
          </Card.Header>
          <Card.Content>服务器上的数据未更改。请刷新后重试。</Card.Content>
          <Card.Footer>
            <Button onPress={() => location.reload()}>刷新</Button>
          </Card.Footer>
        </Card>
      </main>
    ) : (
      this.props.children
    );
  }
}
