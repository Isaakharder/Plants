import { PageHeader } from '../components/PageHeader'
import { VarietiesSection } from '../features/crops/VarietiesSection'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="What am I growing?" />
      <VarietiesSection />
    </>
  )
}
