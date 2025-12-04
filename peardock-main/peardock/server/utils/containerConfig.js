/**
 * Container configuration builder utilities
 * Extracted from deployContainer to improve modularity
 */

import * as validation from './validation.js';

/**
 * Build basic container configuration
 * @param {Object} args - Deployment arguments
 * @returns {Object} - Container configuration
 */
export function buildBasicConfig(args) {
  const containerConfig = {
    name: args.containerName,
    Image: args.image,
  };

  // Basic settings
  if (args.command) {
    containerConfig.Cmd = args.command.split(' ');
  }
  if (args.entrypoint) {
    containerConfig.Entrypoint = args.entrypoint.split(' ');
  }
  if (args.workingDir) {
    containerConfig.WorkingDir = args.workingDir;
  }

  return containerConfig;
}

/**
 * Build environment variables configuration
 * @param {Array} envVars - Environment variables array
 * @returns {Array} - Formatted environment variables
 */
export function buildEnvConfig(envVars) {
  if (!envVars || !Array.isArray(envVars)) {
    return [];
  }

  return envVars
    .filter(e => e.name && e.value !== undefined)
    .map(e => {
      const name = validation.sanitizeEnvVarName(e.name);
      const value = validation.sanitizeEnvVarValue(e.value);
      return name && value !== null ? `${name}=${value}` : null;
    })
    .filter(e => e !== null);
}

/**
 * Build labels configuration
 * @param {Object} labels - Labels object
 * @returns {Object} - Sanitized labels
 */
export function buildLabelsConfig(labels) {
  if (!labels || typeof labels !== 'object') {
    return {};
  }

  const sanitizedLabels = {};
  for (const [key, value] of Object.entries(labels)) {
    const sanitizedKey = validation.sanitizeLabelKey(key);
    const sanitizedValue = validation.sanitizeLabelValue(value);
    if (sanitizedKey && sanitizedValue !== null) {
      sanitizedLabels[sanitizedKey] = sanitizedValue;
    }
  }

  return sanitizedLabels;
}

/**
 * Build networking configuration
 * @param {Object} args - Deployment arguments
 * @returns {Object} - HostConfig networking settings
 */
export function buildNetworkingConfig(args) {
  const hostConfig = {
    NetworkMode: args.networkMode || 'bridge',
  };

  // Port bindings
  if (args.ports && Array.isArray(args.ports)) {
    hostConfig.PortBindings = {};
    args.ports.forEach((portStr) => {
      const sanitizedPort = validation.sanitizeString(portStr, 50);
      if (validation.isValidPortMapping(sanitizedPort)) {
        if (sanitizedPort.includes(':')) {
          const [hostPort, rest] = sanitizedPort.split(':');
          const [containerPort, protocol] = rest.split('/');
          hostConfig.PortBindings[`${containerPort}/${protocol || 'tcp'}`] = [{ HostPort: hostPort }];
        } else {
          const [containerPort, protocol] = sanitizedPort.split('/');
          hostConfig.PortBindings[`${containerPort}/${protocol || 'tcp'}`] = [{ HostPort: containerPort }];
        }
      }
    });
  }

  // DNS
  if (args.dns && Array.isArray(args.dns)) {
    hostConfig.Dns = args.dns
      .map(dns => validation.sanitizeString(dns, 50))
      .filter(dns => validation.isValidDnsServer(dns));
  }

  // Extra hosts
  if (args.extraHosts && Array.isArray(args.extraHosts)) {
    hostConfig.ExtraHosts = args.extraHosts
      .map(host => validation.sanitizeString(host, 200))
      .filter(host => host.includes(':'));
  }

  return hostConfig;
}

/**
 * Build volumes configuration
 * @param {Object} args - Deployment arguments
 * @returns {Object} - HostConfig volumes settings
 */
export function buildVolumesConfig(args) {
  const hostConfig = {};

  // Volumes
  if (args.volumes && Array.isArray(args.volumes)) {
    hostConfig.Binds = args.volumes
      .map(v => validation.sanitizeString(v, 500))
      .filter(v => v && validation.isValidVolumeMount(v));
  }

  // Tmpfs
  if (args.tmpfs && Array.isArray(args.tmpfs)) {
    hostConfig.Tmpfs = {};
    args.tmpfs.forEach(tmpfsStr => {
      const sanitized = validation.sanitizeString(tmpfsStr, 100);
      const [path, ...opts] = sanitized.split(':');
      if (path) {
        hostConfig.Tmpfs[path] = opts.join(':') || '';
      }
    });
  }

  return hostConfig;
}

/**
 * Build resources configuration
 * @param {Object} args - Deployment arguments
 * @returns {Object} - HostConfig resources settings
 */
export function buildResourcesConfig(args) {
  const hostConfig = {};

  // CPU limits
  if (args.cpuLimit) {
    hostConfig.NanoCpus = args.cpuLimit * 1000000000; // Convert to nanoseconds
  }
  if (args.cpuReservation) {
    hostConfig.CpuQuota = args.cpuReservation * 1000000000;
  }
  if (args.cpuShares) {
    hostConfig.CpuShares = args.cpuShares;
  }

  // Memory limits
  if (args.memoryLimit) {
    hostConfig.Memory = args.memoryLimit * 1024 * 1024; // Convert MB to bytes
  }
  if (args.memoryReservation) {
    hostConfig.MemoryReservation = args.memoryReservation * 1024 * 1024;
  }
  if (args.memorySwap !== undefined && args.memorySwap !== null) {
    hostConfig.MemorySwap = args.memorySwap === -1 ? -1 : args.memorySwap * 1024 * 1024;
  }

  // Devices
  if (args.devices && Array.isArray(args.devices)) {
    hostConfig.Devices = args.devices
      .map(deviceStr => validation.sanitizeString(deviceStr, 200))
      .map(deviceStr => {
        const parts = deviceStr.split(':');
        return {
          PathOnHost: parts[0],
          PathInContainer: parts[1] || parts[0],
          CgroupPermissions: parts[2] || 'rwm'
        };
      });
  }

  return hostConfig;
}

/**
 * Build security configuration
 * @param {Object} args - Deployment arguments
 * @returns {Object} - HostConfig security settings
 */
export function buildSecurityConfig(args) {
  const hostConfig = {};

  // Privileged
  if (args.privileged === true) {
    hostConfig.Privileged = true;
  }

  // Capabilities
  if (args.capabilities && Array.isArray(args.capabilities)) {
    hostConfig.CapAdd = args.capabilities
      .map(cap => validation.sanitizeString(cap, 50).toUpperCase())
      .filter(cap => /^[A-Z_]+$/.test(cap));
  }

  // Security options
  if (args.securityOpts && Array.isArray(args.securityOpts)) {
    hostConfig.SecurityOpt = args.securityOpts
      .map(opt => validation.sanitizeString(opt, 200));
  }

  return hostConfig;
}

/**
 * Build runtime configuration
 * @param {Object} args - Deployment arguments
 * @returns {Object} - HostConfig runtime settings
 */
export function buildRuntimeConfig(args) {
  const hostConfig = {};

  // Restart policy
  if (args.restartPolicy) {
    hostConfig.RestartPolicy = {
      Name: args.restartPolicy,
      MaximumRetryCount: args.restartMaxRetries || 0
    };
  }

  // Auto remove
  if (args.autoRemove === true) {
    hostConfig.AutoRemove = true;
  }

  // Init process
  if (args.init === true) {
    hostConfig.Init = true;
  }

  // Sysctls
  if (args.sysctls && typeof args.sysctls === 'object') {
    hostConfig.Sysctls = {};
    for (const [key, value] of Object.entries(args.sysctls)) {
      const sanitizedKey = validation.sanitizeString(key, 100);
      const sanitizedValue = validation.sanitizeString(String(value), 100);
      if (sanitizedKey && sanitizedValue) {
        hostConfig.Sysctls[sanitizedKey] = sanitizedValue;
      }
    }
  }

  // Ulimits
  if (args.ulimits && Array.isArray(args.ulimits)) {
    hostConfig.Ulimits = args.ulimits
      .map(ulimit => {
        if (typeof ulimit === 'object' && ulimit.Name) {
          return {
            Name: validation.sanitizeString(ulimit.Name, 50),
            Soft: validation.validateNumber(ulimit.Soft, 0, Infinity),
            Hard: validation.validateNumber(ulimit.Hard, 0, Infinity)
          };
        }
        return null;
      })
      .filter(ulimit => ulimit !== null);
  }

  // OOM kill disable
  if (args.oomKillDisable === true) {
    hostConfig.OomKillDisable = true;
  }

  // PIDs limit
  if (args.pidsLimit !== undefined && args.pidsLimit !== null) {
    hostConfig.PidsLimit = args.pidsLimit === -1 ? 0 : args.pidsLimit;
  }

  // Shared memory size
  if (args.shmSize) {
    hostConfig.ShmSize = args.shmSize * 1024 * 1024; // Convert MB to bytes
  }

  return hostConfig;
}

