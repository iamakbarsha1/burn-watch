import { ApproveDeviceForm } from './ApproveDeviceForm'
import { PageHeader, Section } from '@/components/ui'

export default function DevicesPage() {
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Devices"
        subtitle="Approve a machine before it can report usage"
      />
      <Section title="Approve a device">
        <ApproveDeviceForm />
      </Section>
    </div>
  )
}
