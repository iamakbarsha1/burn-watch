import { describe, it, expect } from 'vitest'
import { updateInstallCommand } from './update.js'

describe('updateInstallCommand', () => {
  it('picks the PowerShell installer on Windows', () => {
    expect(updateInstallCommand('win32')).toContain('install.ps1')
  })

  it('picks the shell installer everywhere else', () => {
    expect(updateInstallCommand('darwin')).toContain('install.sh')
    expect(updateInstallCommand('linux')).toContain('install.sh')
  })
})
