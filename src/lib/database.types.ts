// Mirrors supabase/migrations. Regenerate once the project is linked:
//   npx supabase gen types typescript --linked > src/lib/database.types.ts

export type CropColor = 'red' | 'orange' | 'yellow' | 'green' | 'other'

type OrganizationRow = {
  id: string
  name: string
  created_at: string
  updated_at: string
}

type CropRow = {
  id: string
  organization_id: string
  name: string
  color: CropColor
  planting_date: string
  pullout_date: string
  area_m2: number
  picking_stems: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: OrganizationRow
        Insert: never
        Update: { name?: string }
        Relationships: []
      }
      organization_members: {
        Row: {
          organization_id: string
          user_id: string
          role: 'owner' | 'member'
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: [
          {
            foreignKeyName: 'organization_members_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      crops: {
        Row: CropRow
        Insert: Omit<CropRow, 'id' | 'created_by' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<CropRow, 'id' | 'organization_id' | 'created_by' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      create_organization: {
        Args: { org_name: string }
        Returns: OrganizationRow
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
