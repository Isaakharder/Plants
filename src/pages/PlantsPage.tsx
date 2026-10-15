import { PlantsTwin } from '../features/plants/PlantsTwin'

export function PlantsPage() {
  return (
    <>
      {/* No visible page header: the controls are the page's top. Keep an h1 for screen readers only. */}
      <h1 className="visually-hidden">Plants</h1>
      <PlantsTwin />
    </>
  )
}
