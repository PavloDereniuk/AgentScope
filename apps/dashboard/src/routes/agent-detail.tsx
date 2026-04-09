import { useParams } from 'react-router-dom';

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div>
      <h1 className="text-2xl font-bold">Agent Detail</h1>
      <p className="mt-2 text-muted-foreground">Agent ID: {id}</p>
    </div>
  );
}
