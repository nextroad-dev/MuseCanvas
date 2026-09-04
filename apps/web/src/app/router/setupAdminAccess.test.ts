// Behavior coverage for completed-setup access: admins may revisit /setup,
// anonymous/non-admin users are funneled back through /admin handling.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveCompletedSetupPageRedirect,
  resolveSetupGuardRedirect,
} from './setupAdminAccess'

describe('resolveSetupGuardRedirect', () => {
  it('sends non-wizard routes to /setup while onboarding is incomplete', () => {
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: false,
        statusFailed: false,
        isSetupRoute: false,
        isLegalPublicRoute: false,
        isAdmin: false,
      }),
      '/setup',
    )
  })

  it('keeps the wizard and legal public pages reachable while incomplete', () => {
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: false,
        statusFailed: false,
        isSetupRoute: true,
        isLegalPublicRoute: false,
        isAdmin: false,
      }),
      null,
    )
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: false,
        statusFailed: false,
        isSetupRoute: false,
        isLegalPublicRoute: true,
        isAdmin: false,
      }),
      null,
    )
  })

  it('never redirects on a status transport failure', () => {
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: false,
        statusFailed: true,
        isSetupRoute: false,
        isLegalPublicRoute: false,
        isAdmin: false,
      }),
      null,
    )
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: true,
        statusFailed: true,
        isSetupRoute: true,
        isLegalPublicRoute: false,
        isAdmin: false,
      }),
      null,
    )
  })

  it('lets an authenticated admin stay on completed /setup', () => {
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: true,
        statusFailed: false,
        isSetupRoute: true,
        isLegalPublicRoute: false,
        isAdmin: true,
      }),
      null,
    )
  })

  it('funnels anonymous and non-admin users off completed /setup', () => {
    for (const isAdmin of [false]) {
      assert.equal(
        resolveSetupGuardRedirect({
          setupComplete: true,
          statusFailed: false,
          isSetupRoute: true,
          isLegalPublicRoute: false,
          isAdmin,
        }),
        '/admin',
      )
    }
  })

  it('leaves non-setup routes alone once onboarding is complete', () => {
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: true,
        statusFailed: false,
        isSetupRoute: false,
        isLegalPublicRoute: false,
        isAdmin: true,
      }),
      null,
    )
    assert.equal(
      resolveSetupGuardRedirect({
        setupComplete: true,
        statusFailed: false,
        isSetupRoute: false,
        isLegalPublicRoute: false,
        isAdmin: false,
      }),
      null,
    )
  })
})

describe('resolveCompletedSetupPageRedirect', () => {
  it('keeps admins on the completed wizard page', () => {
    assert.equal(
      resolveCompletedSetupPageRedirect({ setupComplete: true, statusFailed: false, isAdmin: true }),
      null,
    )
  })

  it('sends non-admins on the completed page back to /admin handling', () => {
    assert.equal(
      resolveCompletedSetupPageRedirect({ setupComplete: true, statusFailed: false, isAdmin: false }),
      '/admin',
    )
  })

  it('does not redirect while incomplete or when status failed', () => {
    assert.equal(
      resolveCompletedSetupPageRedirect({ setupComplete: false, statusFailed: false, isAdmin: false }),
      null,
    )
    assert.equal(
      resolveCompletedSetupPageRedirect({ setupComplete: true, statusFailed: true, isAdmin: false }),
      null,
    )
  })
})
