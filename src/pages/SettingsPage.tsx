import { PageHeader } from '../components/PageHeader'
import { AttentionRulesSection } from '../features/attentionRules/AttentionRulesSection'
import { ClimateSettingsSection } from '../features/climate/ClimateSettingsSection'
import { PepperTypesSection } from '../features/crops/PepperTypesSection'
import { VarietiesSection } from '../features/crops/VarietiesSection'
import { MobileStatusOptionsSection } from '../features/statusOptions/MobileStatusOptionsSection'

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="What am I growing?" />
      <VarietiesSection />
      <PepperTypesSection />
      <AttentionRulesSection />
      <MobileStatusOptionsSection />
      <ClimateSettingsSection />
    </>
  )
}
