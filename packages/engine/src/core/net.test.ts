import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, isLoopbackHost, isPrivateHostname } from './net.ts';

describe('isLoopbackAddress (who may reach the HTTP API)', () => {
  it('accepts the addresses that only this machine can reach', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '127.255.255.254',
      'localhost',
      'LOCALHOST',
      ' localhost ',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::FFFF:127.0.0.1',
      '[::ffff:127.0.0.1]',
    ]) {
      expect(isLoopbackAddress(host), host).toBe(true);
    }
  });

  it('refuses addresses on every interface, other networks and names that only look local', () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.5',
      '10.0.0.1',
      '8.8.8.8',
      'example.com',
      '127.evil.com',
      '127.0.0.1.example.com',
      'localhost.evil.com',
      '127.999.1.1',
      '::ffff:10.0.0.1',
      '::2',
      '',
    ]) {
      expect(isLoopbackAddress(host), host).toBe(false);
    }
  });

  it('refuses a name below localhost, which can be made to point anywhere, and anything with a port', () => {
    for (const host of ['app.localhost', 'a.b.localhost', 'localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
      expect(isLoopbackAddress(host), host).toBe(false);
    }
  });
});

describe('isLoopbackHost (egress and warnings)', () => {
  it('recognises this machine as written in a URL, with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:11434',
      '127.0.0.1',
      '127.0.0.1:8000',
      '127.4.5.6:80',
      '[::1]',
      '[::1]:11434',
      'app.localhost',
      'app.localhost:3000',
      'LOCALHOST:1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('also takes a bare address that the HTTP API rule accepts', () => {
    for (const host of ['::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('only counts complete IP addresses, so a public host named like one is not local', () => {
    for (const host of [
      'api.openai.com',
      'example.com:8080',
      '10.0.0.5',
      '192.168.1.5:8080',
      '0.0.0.0',
      '127.0.0.1.attacker.test',
      '127.evil.com',
      '127.999.1.1',
      'localhost.evil.com',
      '',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('is the wider of the two rules, never the narrower', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(host)).toBe(true);
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });
});

describe('isPrivateHostname', () => {
  it('accepts loopback, private ranges, link-local, intranet names and single-label names', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '10.1.2.3',
      '172.16.0.1',
      '172.20.1.1',
      '172.31.255.1',
      '192.168.0.9',
      '192.168.1.10',
      '169.254.1.1',
      '[::1]',
      'fd12::1',
      'fe80::1',
      'ollama',
      'box',
      'ci.local',
      'llm.internal',
      'gpu.lan',
      'app.localhost',
    ]) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
  });

  it('refuses public addresses and names, and names that only start like an address', () => {
    for (const host of [
      '172.32.0.1',
      '172.15.0.1',
      '8.8.8.8',
      '192.169.0.1',
      'api.openai.com',
      'api.example.com',
      '10.attacker.test',
      '172.20.attacker.test',
      '127.0.0.1.attacker.test',
      '2001:db8::1',
    ]) {
      expect(isPrivateHostname(host), host).toBe(false);
    }
  });
});
