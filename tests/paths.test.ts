/**
 * Path dialect checks: UNC ↔ Linux ↔ Windows drive, plus lexical
 * normalization. No distro needed — these are pure functions, and getting them
 * wrong is what made the reference plugin synthesize `/mnt` from `statSync`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { containsPosix, driveToMnt, parseUnc, resolveAddress, toPosix, toUnc } from '../src/paths.ts'

const UNC_HOME = String.raw`\\wsl.localhost\Ubuntu\home\sidady`
/** `\\wsl$\Ubuntu\` — no trailing backslash in the literal, it would escape the backtick. */
const UNC_ROOT = String.raw`\\wsl$\Ubuntu` + '\\'

test('UNC round-trips through the workspace key', () => {
  assert.equal(toUnc('Ubuntu', '/home/sidady'), UNC_HOME)
  assert.deepEqual(parseUnc(UNC_HOME), { distro: 'Ubuntu', path: '/home/sidady' })
  assert.deepEqual(parseUnc(UNC_ROOT), { distro: 'Ubuntu', path: '/' })
  assert.equal(parseUnc('C:\\Users'), undefined)
})

test('a drive path becomes a mount point inside a distribution', () => {
  assert.equal(driveToMnt('C:\\Users\\GT14'), '/mnt/c/Users/GT14')
  assert.equal(driveToMnt('/home/x'), undefined)
})

test('posix normalization is lexical', () => {
  assert.equal(toPosix('/a//b/./c/../d/'), '/a/b/d')
  assert.equal(toPosix('//'), '/')
  assert.equal(containsPosix('/a/b', '/a/b/c'), true)
  assert.equal(containsPosix('/a/b', '/a/bc'), false)
  assert.equal(containsPosix('/', '/anything'), true)
})

test('resolveAddress prefers an explicit distro and falls back to the base', () => {
  assert.deepEqual(resolveAddress(UNC_HOME), { distro: 'Ubuntu', path: '/home/sidady' })
  assert.deepEqual(resolveAddress('C:\\x', { distro: 'Ubuntu', path: '/' }), {
    distro: 'Ubuntu',
    path: '/mnt/c/x',
  })
  assert.deepEqual(resolveAddress('rel', { distro: 'Ubuntu', path: '/home/u' }), {
    distro: 'Ubuntu',
    path: '/home/u/rel',
  })
  assert.equal(resolveAddress('C:\\x'), undefined)
})
