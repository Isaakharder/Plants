import { PageHeader } from '../components/PageHeader'
import { AttentionRulesSection } from '../features/attentionRules/AttentionRulesSection'
import { VarietiesSection } from '../features/crops/VarietiesSection'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="What am I growing?" />
      <VarietiesSection />
      <AttentionRulesSection />
    </>
  )
}
