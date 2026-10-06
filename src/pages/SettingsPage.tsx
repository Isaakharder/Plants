import { PageHeader } from '../components/PageHeader'
import { AttentionRulesSection } from '../features/attentionRules/AttentionRulesSection'
import { VarietiesSection } from '../features/crops/VarietiesSection'
import { MobileStatusOptionsSection } from '../features/statusOptions/MobileStatusOptionsSection'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="What am I growing?" />
      <VarietiesSection />
      <AttentionRulesSection />
      <MobileStatusOptionsSection />
    </>
  )
}
