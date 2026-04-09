import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <Card className="mx-auto mt-12 max-w-md">
          <CardContent className="flex flex-col items-center gap-4 py-8">
            <AlertTriangle className="h-12 w-12 text-destructive" />
            <h2 className="text-lg font-semibold">Something went wrong</h2>
            <p className="text-center text-sm text-muted-foreground">{this.state.error.message}</p>
            <Button
              variant="outline"
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
            >
              Reload page
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
