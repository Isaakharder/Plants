import { Link } from 'react-router-dom'
import { EmptyState } from '../components/States'

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      action={
        <Link to="/" className="button button-secondary">
          Go home
        </Link>
      }
    />
  )
}
