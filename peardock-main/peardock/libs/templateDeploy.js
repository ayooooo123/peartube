// Import dependencies first (ES6 imports must be at top)
import { closeAllModals, showStatusIndicator, hideStatusIndicator, updateStatusIndicator, showAlert } from './uiUtils.js';
import notificationManager from './notifications.js';

// DOM Elements - Lazy loaded (initialized when modal opens)
let templateList = null;
let templateSearchInput = null;
let templateDeployModal = null;
let deployForm = null;
let templates = [];
let searchInputListenerSetup = false; // Track if search input listener is set up
let formSubmitListenerSetup = false; // Track if form submit listener is set up

// Array item counters for unique IDs
let portCounter = 0;
let volumeCounter = 0;
let envCounter = 0;
let labelCounter = 0;
let dnsCounter = 0;
let extraHostCounter = 0;
let deviceCounter = 0;
let capabilityCounter = 0;
let securityOptCounter = 0;
let logOptCounter = 0;
let sysctlCounter = 0;
let ulimitCounter = 0;
let tmpfsCounter = 0;

// Utility functions are now imported from uiUtils.js
// Also explicitly close the deploy modal if needed
function closeDeployModal() {
  if (templateDeployModal) {
    templateDeployModal.hide();
  }
}

// Lazy initialization - set up DOM elements and modal only when needed
function initTemplateDeployer() {
  // Initialize DOM elements if not already cached
  if (!templateList) {
    templateList = document.getElementById('template-list');
  }
  if (!templateSearchInput) {
    templateSearchInput = document.getElementById('template-search-input');
  }
  if (!deployForm) {
    deployForm = document.getElementById('deploy-form');
  }
  
  // Create Bootstrap Modal if not already created
  if (!templateDeployModal && typeof bootstrap !== 'undefined') {
    const modalElement = document.getElementById('templateDeployModalUnique');
    if (modalElement) {
      templateDeployModal = new bootstrap.Modal(modalElement);
    }
  }
  
  // Set up search input listener if not already set up
  setupSearchInputListener();
  
  // Set up form submit listener if not already set up
  setupFormSubmitListener();
}

// Fetch templates from the URL
async function fetchTemplates() {
    // Ensure template deployer is initialized before fetching
    initTemplateDeployer();
    
    try {
        const response = await fetch('https://raw.githubusercontent.com/Lissy93/portainer-templates/main/templates.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        templates = data.templates || []; // Update global templates
        displayTemplateList(templates);
    } catch (error) {
        console.error('[ERROR] Failed to fetch templates:', error.message);
        showAlert('danger', 'Failed to load templates.');
    }
}

// Filter templates by search input (will be set up lazily)
function setupSearchInputListener() {
    if (!templateSearchInput || searchInputListenerSetup) return;
    
    templateSearchInput.addEventListener('input', () => {
        const searchQuery = templateSearchInput.value.toLowerCase();
        const filteredTemplates = templates.filter(template =>
            template.title.toLowerCase().includes(searchQuery) ||
            template.description.toLowerCase().includes(searchQuery)
        );
        displayTemplateList(filteredTemplates);
    });
    searchInputListenerSetup = true;
}

// Set up form submit listener (will be set up lazily)
function setupFormSubmitListener() {
    if (!deployForm || formSubmitListenerSetup) return;
    
    deployForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        let formData;
        try {
            formData = collectFormData();
        } catch (collectError) {
            console.error('[ERROR] Failed to collect form data:', collectError);
            console.error('[ERROR] Collect error stack:', collectError.stack);
            showAlert('danger', 'Failed to collect form data. Check console for details.');
            return;
        }
        
        // Validate
        let errors = [];
        try {
            errors = validateFormData(formData);
        } catch (validateError) {
            console.error('[ERROR] Failed to validate form data:', validateError);
            console.error('[ERROR] Validate error stack:', validateError.stack);
            showAlert('danger', 'Failed to validate form data. Check console for details.');
            return;
        }
        
        if (errors.length > 0) {
            showAlert('danger', errors.join(' '));
            return;
        }

        // Ensure formData is initialized before use
        if (!formData || typeof formData !== 'object') {
            console.error('[ERROR] Invalid form data:', formData);
            showAlert('danger', 'Invalid form data. Please check your input and try again.');
            return;
        }

        // Safely get container name with fallback
        const containerName = (formData && formData.containerName) ? String(formData.containerName) : 'container';
        
        // Close modal immediately before async operation
        if (typeof closeAllModals === 'function') {
            closeAllModals();
        }
        closeDeployModal();
        
        // Add notification for container creation
        notificationManager.add('info', `Creating container "${containerName}"...`, { autoDismiss: false });
        showStatusIndicator('Preparing container configuration...');

        try {
            // Update message when starting deployment
            updateStatusIndicator('Creating container...');
            
            // Deploy container with proper error handling
            const successResponse = await deployDockerContainer(formData);
            
            // Ensure we have a valid response
            if (!successResponse || typeof successResponse !== 'object') {
                throw new Error('Invalid response from deployment function');
            }
            
            // Update message to indicate we're transferring
            updateStatusIndicator('Transferring you to the container');
            
            // Safely extract success message
            const successMessage = (successResponse && successResponse.message) 
                ? String(successResponse.message) 
                : 'Container deployed successfully!';
            
            // Update notification to success
            notificationManager.add('success', `Container "${containerName}" created successfully!`);
            showAlert('success', successMessage);
            
            // Refresh container list and navigate to container details
            if (typeof window.sendCommand === 'function') {
                window.sendCommand('listContainers');
                
                // Wait for container list to update, then navigate to container details
                // Keep spinner visible during this time
                setTimeout(() => {
                    hideStatusIndicator();
                    if (typeof window.navigateToNewContainer === 'function') {
                        window.navigateToNewContainer(containerName);
                    }
                }, 1500);
            } else {
                hideStatusIndicator();
            }
        } catch (error) {
            // Safely extract error message
            const errorMessage = (error && error.message) 
                ? String(error.message) 
                : 'Failed to deploy container. Check console for details.';
            
            console.error('[ERROR] Failed to deploy container:', errorMessage);
            if (error && error.stack) {
                console.error('[ERROR] Full error stack:', error.stack);
            }
            if (error) {
                console.error('[ERROR] Error details:', error);
            }
            
            // Ensure status indicator is hidden
            try {
                hideStatusIndicator();
            } catch (e) {
                console.warn('[WARN] Failed to hide status indicator:', e);
            }
            
            // Update notification to error
            notificationManager.add('danger', `Failed to create container "${containerName}"`);
            
            showAlert('danger', errorMessage);
        }
    });
    formSubmitListenerSetup = true;
}

// Default icon as SVG data URI (generic container/box icon) - URL encoded
const DEFAULT_TEMPLATE_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L22 7V17L12 22L2 17V7L12 2Z" stroke="#666666" stroke-width="1.5" fill="rgba(100, 116, 255, 0.1)"/></svg>');

// Display templates in the list
function displayTemplateList(templates) {
    // Ensure template list is initialized
    if (!templateList) {
        initTemplateDeployer();
    }
    if (!templateList) {
        console.error('[ERROR] Template list element not found');
        return;
    }
    
    templateList.innerHTML = '';
    templates.forEach(template => {
        const listItem = document.createElement('li');
        listItem.className = 'list-group-item d-flex justify-content-between align-items-center';
        
        // Create the div container
        const div = document.createElement('div');
        
        // Create img element with error handler for default icon fallback
        const img = document.createElement('img');
        const logoUrl = template.logo && template.logo.trim() ? template.logo : DEFAULT_TEMPLATE_ICON;
        img.src = logoUrl;
        img.alt = 'Logo';
        img.className = 'me-2';
        img.style.width = '24px';
        img.style.height = '24px';
        img.style.objectFit = 'contain';
        
        // Set error handler BEFORE appending to DOM to ensure it's attached
        img.addEventListener('error', function handleImageError() {
            // Replace with default icon on load error (404, network issues, CORS, etc.)
            if (this.src !== DEFAULT_TEMPLATE_ICON) {
                this.src = DEFAULT_TEMPLATE_ICON;
                // Remove this handler to prevent infinite loop
                this.removeEventListener('error', handleImageError);
            }
        });
        
        // Create title span
        const titleSpan = document.createElement('span');
        titleSpan.textContent = template.title;
        
        // Create deploy button
        const deployBtn = document.createElement('button');
        deployBtn.className = 'btn btn-primary btn-sm deploy-btn';
        deployBtn.textContent = 'Deploy';
        deployBtn.addEventListener('click', () => {
            openDeployModal(template);
        });
        
        // Assemble the structure
        div.appendChild(img);
        div.appendChild(titleSpan);
        listItem.appendChild(div);
        listItem.appendChild(deployBtn);
        
        templateList.appendChild(listItem);
    });
}

// Array management functions
function addPortMapping(portData = null) {
    const container = document.getElementById('deploy-ports-container');
    if (!container) {
        console.error('[ERROR] Ports container not found - element with id "deploy-ports-container" does not exist');
        return;
    }

    const id = `port-${portCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item port-mapping-item';
    item.id = id;

    // Default values
    let hostPort = '';
    let containerPort = '';
    let protocol = 'tcp';

    if (portData != null) {
        const portStr = String(portData).trim();

        if (!portStr) {
            // Empty → leave defaults
        } else if (portStr.includes(':')) {
            // Format: "host:container/protocol" OR "host:container"
            const [hostPart, containerPart] = portStr.split(':');

            hostPort = hostPart.trim();

            if (containerPart.includes('/')) {
                const [cPort, proto] = containerPart.split('/');
                containerPort = cPort.trim();
                protocol = (proto && proto.trim().toLowerCase() === 'udp') ? 'udp' : 'tcp';
            } else {
                containerPort = containerPart.trim();
                protocol = 'tcp'; // default if no protocol
            }
        } else if (portStr.includes('/')) {
            // Format: "container/protocol"
            const [cPort, proto] = portStr.split('/');
            containerPort = cPort.trim();
            protocol = (proto && proto.trim().toLowerCase() === 'udp') ? 'udp' : 'tcp';
        } else {
            // Just a number → assume container port only
            containerPort = portStr.trim();
            protocol = 'tcp';
        }

        // Final validation: container port is mandatory
        if (!containerPort || isNaN(parseInt(containerPort, 10))) {
            console.warn('[WARN] Invalid container port in template:', portData);
            containerPort = '';
        }
    }

    item.innerHTML = `
        <div class="port-mapping-fields">
            <div class="port-field-group">
                <label class="port-field-label">Host Port</label>
                <input type="number"
                       class="form-control bg-dark text-white port-host-input"
                       placeholder="8080"
                       min="1"
                       max="65535"
                       data-port-host="${id}"
                       value="${hostPort}"
                       oninput="validatePortMapping('${id}')">
                <small class="port-error-msg" data-port-host-error="${id}" style="display: none;"></small>
            </div>
            <div class="port-connector">
                <i class="fas fa-arrow-right"></i>
            </div>
            <div class="port-field-group">
                <label class="port-field-label">Container Port</label>
                <input type="number"
                       class="form-control bg-dark text-white port-container-input"
                       placeholder="80"
                       min="1"
                       max="65535"
                       required
                       data-port-container="${id}"
                       value="${containerPort}"
                       oninput="validatePortMapping('${id}')">
                <small class="port-error-msg" data-port-container-error="${id}" style="display: none;"></small>
            </div>
            <div class="port-field-group">
                <label class="port-field-label">Protocol</label>
                <select class="form-select bg-dark text-white port-protocol-input"
                        data-port-protocol="${id}"
                        onchange="validatePortMapping('${id}')">
                    <option value="tcp" ${protocol === 'tcp' ? 'selected' : ''}>TCP</option>
                    <option value="udp" ${protocol === 'udp' ? 'selected' : ''}>UDP</option>
                </select>
            </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

// Validate port mapping in real-time
function validatePortMapping(portId) {
    const hostInput = document.querySelector(`[data-port-host="${portId}"]`);
    const containerInput = document.querySelector(`[data-port-container="${portId}"]`);
    const hostError = document.querySelector(`[data-port-host-error="${portId}"]`);
    const containerError = document.querySelector(`[data-port-container-error="${portId}"]`);
    
    let isValid = true;
    
    // Validate host port (optional)
    if (hostInput && hostInput.value) {
        const hostPort = parseInt(hostInput.value, 10);
        if (isNaN(hostPort) || hostPort < 1 || hostPort > 65535) {
            if (hostError) {
                hostError.textContent = 'Port must be between 1 and 65535';
                hostError.style.display = 'block';
                hostInput.classList.add('is-invalid');
            }
            isValid = false;
        } else {
            if (hostError) {
                hostError.style.display = 'none';
                hostInput.classList.remove('is-invalid');
            }
        }
    } else if (hostError) {
        hostError.style.display = 'none';
        if (hostInput) hostInput.classList.remove('is-invalid');
    }
    
    // Validate container port (required)
    if (containerInput) {
        const containerPort = parseInt(containerInput.value, 10);
        if (!containerInput.value || isNaN(containerPort) || containerPort < 1 || containerPort > 65535) {
            if (containerError) {
                containerError.textContent = 'Container port is required (1-65535)';
                containerError.style.display = 'block';
                containerInput.classList.add('is-invalid');
            }
            isValid = false;
        } else {
            if (containerError) {
                containerError.style.display = 'none';
                containerInput.classList.remove('is-invalid');
            }
        }
    }
    
    // Check for duplicate host ports
    if (hostInput && hostInput.value) {
        const hostPort = hostInput.value;
        const allHostInputs = document.querySelectorAll('.port-host-input');
        let duplicateCount = 0;
        allHostInputs.forEach(input => {
            if (input.value === hostPort && input !== hostInput) {
                duplicateCount++;
            }
        });
        
        if (duplicateCount > 0) {
            if (hostError) {
                hostError.textContent = 'This host port is already in use';
                hostError.style.display = 'block';
                hostInput.classList.add('is-invalid');
            }
            isValid = false;
        }
    }
    
    updatePreview();
    return isValid;
}

function addVolumeMount(volumeData = null) {
    const container = document.getElementById('deploy-volumes-container');
    const id = `volume-${volumeCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item volume-mount-item';
    item.id = id;
    
    // Parse existing volume data if provided
    let volumeType = 'bind';
    let hostPath = '';
    let containerPath = '';
    let mountMode = 'rw';
    
    if (volumeData) {
        const parts = volumeData.split(':');
        if (parts.length >= 2) {
            // Check if it's a named volume (starts with volume name, no leading slash)
            if (!parts[0].startsWith('/') && !parts[0].startsWith('~')) {
                volumeType = 'named';
                hostPath = parts[0];
            } else {
                volumeType = 'bind';
                hostPath = parts[0];
            }
            containerPath = parts[1];
            if (parts.length === 3) {
                mountMode = parts[2];
            }
        }
    }
    
    item.innerHTML = `
        <div class="volume-mount-fields">
            <div class="volume-field-group">
                <label class="volume-field-label">Type</label>
                <select class="form-select bg-dark text-white volume-type-input" 
                        data-volume-type="${id}"
                        onchange="handleVolumeTypeChange('${id}')">
                    <option value="bind" ${volumeType === 'bind' ? 'selected' : ''}>Bind Mount</option>
                    <option value="named" ${volumeType === 'named' ? 'selected' : ''}>Named Volume</option>
                </select>
            </div>
            <div class="volume-field-group volume-host-path-group" style="${volumeType === 'named' ? 'display: none;' : ''}">
                <label class="volume-field-label">Host Path</label>
                <div class="input-group">
                    <input type="text" 
                           class="form-control bg-dark text-white volume-host-input" 
                           placeholder="/host/path" 
                           data-volume-host="${id}"
                           value="${hostPath}"
                           oninput="validateVolumeMount('${id}')">
                    <button type="button" 
                            class="btn btn-outline-secondary" 
                            onclick="openFileBrowser('${id}')"
                            title="Browse directory">
                        <i class="fas fa-folder-open"></i>
                    </button>
                </div>
                <small class="volume-error-msg" data-volume-host-error="${id}" style="display: none;"></small>
            </div>
            <div class="volume-field-group volume-named-group" style="${volumeType === 'bind' ? 'display: none;' : ''}">
                <label class="volume-field-label">Volume Name</label>
                <select class="form-select bg-dark text-white volume-named-input" 
                        data-volume-named="${id}"
                        onchange="validateVolumeMount('${id}')"
                        onfocus="if(this.options.length <= 1) loadVolumesForSelect('${id}')"
                        onclick="if(this.options.length <= 1) loadVolumesForSelect('${id}')">
                    <option value="">Select or create volume...</option>
                </select>
                <small class="volume-error-msg" data-volume-named-error="${id}" style="display: none;"></small>
            </div>
            <div class="volume-connector">
                <i class="fas fa-arrow-right"></i>
            </div>
            <div class="volume-field-group">
                <label class="volume-field-label">Container Path</label>
                <input type="text" 
                       class="form-control bg-dark text-white volume-container-input" 
                       placeholder="/container/path" 
                       required
                       data-volume-container="${id}"
                       value="${containerPath}"
                       oninput="validateVolumeMount('${id}')">
                <small class="volume-error-msg" data-volume-container-error="${id}" style="display: none;"></small>
            </div>
            <div class="volume-field-group">
                <label class="volume-field-label">Mode</label>
                <select class="form-select bg-dark text-white volume-mode-input" 
                        data-volume-mode="${id}"
                        onchange="validateVolumeMount('${id}')">
                    <option value="rw" ${mountMode === 'rw' ? 'selected' : ''}>Read-Write</option>
                    <option value="ro" ${mountMode === 'ro' ? 'selected' : ''}>Read-Only</option>
                </select>
            </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    
    // Load volumes if named volume is selected
    if (volumeType === 'named') {
        loadVolumesForSelect(id);
    }
    
    updatePreview();
}

// Handle volume type change
function handleVolumeTypeChange(volumeId) {
    const typeSelect = document.querySelector(`[data-volume-type="${volumeId}"]`);
    const hostPathGroup = document.querySelector(`[data-volume-host="${volumeId}"]`)?.closest('.volume-host-path-group');
    const namedGroup = document.querySelector(`[data-volume-named="${volumeId}"]`)?.closest('.volume-named-group');
    
    if (!typeSelect) return;
    
    const volumeType = typeSelect.value;
    
    if (volumeType === 'bind') {
        if (hostPathGroup) hostPathGroup.style.display = '';
        if (namedGroup) namedGroup.style.display = 'none';
    } else {
        if (hostPathGroup) hostPathGroup.style.display = 'none';
        if (namedGroup) namedGroup.style.display = '';
        // Always fetch fresh volumes list when Named Volume is selected
        loadVolumesForSelect(volumeId);
    }
    
    validateVolumeMount(volumeId);
    updatePreview();
}

// Validate volume mount in real-time
function validateVolumeMount(volumeId) {
    const typeSelect = document.querySelector(`[data-volume-type="${volumeId}"]`);
    const hostInput = document.querySelector(`[data-volume-host="${volumeId}"]`);
    const namedSelect = document.querySelector(`[data-volume-named="${volumeId}"]`);
    const containerInput = document.querySelector(`[data-volume-container="${volumeId}"]`);
    const hostError = document.querySelector(`[data-volume-host-error="${volumeId}"]`);
    const namedError = document.querySelector(`[data-volume-named-error="${volumeId}"]`);
    const containerError = document.querySelector(`[data-volume-container-error="${volumeId}"]`);
    
    let isValid = true;
    const volumeType = typeSelect?.value || 'bind';
    
    // Validate container path (required)
    if (containerInput) {
        const containerPath = containerInput.value.trim();
        if (!containerPath) {
            if (containerError) {
                containerError.textContent = 'Container path is required';
                containerError.style.display = 'block';
                containerInput.classList.add('is-invalid');
            }
            isValid = false;
        } else if (!containerPath.startsWith('/')) {
            if (containerError) {
                containerError.textContent = 'Container path must start with /';
                containerError.style.display = 'block';
                containerInput.classList.add('is-invalid');
            }
            isValid = false;
        } else {
            if (containerError) {
                containerError.style.display = 'none';
                containerInput.classList.remove('is-invalid');
            }
        }
    }
    
    // Validate based on type
    if (volumeType === 'bind') {
        if (hostInput) {
            const hostPath = hostInput.value.trim();
            if (!hostPath) {
                if (hostError) {
                    hostError.textContent = 'Host path is required for bind mounts';
                    hostError.style.display = 'block';
                    hostInput.classList.add('is-invalid');
                }
                isValid = false;
            } else if (hostPath.includes('..')) {
                if (hostError) {
                    hostError.textContent = 'Path traversal not allowed';
                    hostError.style.display = 'block';
                    hostInput.classList.add('is-invalid');
                }
                isValid = false;
            } else {
                if (hostError) {
                    hostError.style.display = 'none';
                    hostInput.classList.remove('is-invalid');
                }
            }
        }
    } else {
        // Named volume
        if (namedSelect) {
            const volumeName = namedSelect.value.trim();
            if (!volumeName) {
                if (namedError) {
                    namedError.textContent = 'Please select or create a volume';
                    namedError.style.display = 'block';
                    namedSelect.classList.add('is-invalid');
                }
                isValid = false;
            } else {
                if (namedError) {
                    namedError.style.display = 'none';
                    namedSelect.classList.remove('is-invalid');
                }
            }
        }
    }
    
    updatePreview();
    return isValid;
}

function addTmpfsMount() {
    const container = document.getElementById('deploy-tmpfs-container');
    const id = `tmpfs-${tmpfsCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="/tmp:100m" data-tmpfs-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

// Helper function to determine input type based on env var properties
function determineInputType(envVar) {
    const name = (envVar.name || '').toUpperCase();
    const defaultValue = envVar.default || envVar.set || '';
    
    // Check for select dropdown
    if (envVar.select && Array.isArray(envVar.select) && envVar.select.length > 0) {
        return 'select';
    }
    
    // Check for boolean
    if (typeof defaultValue === 'boolean' || defaultValue === 'true' || defaultValue === 'false') {
        return 'checkbox';
    }
    
    // Check for password fields
    if (name.includes('PASSWORD') || name.includes('SECRET') || name.includes('KEY') || 
        name.includes('TOKEN') || name.includes('AUTH') || name.includes('CREDENTIAL')) {
        return 'password';
    }
    
    // Check for numeric values
    if (typeof defaultValue === 'number' || (!isNaN(parseFloat(defaultValue)) && isFinite(defaultValue) && defaultValue !== '')) {
        return 'number';
    }
    
    // Check for long text (URLs, descriptions, etc.)
    if (defaultValue.length > 100 || name.includes('URL') || name.includes('DESCRIPTION') || 
        name.includes('NOTE') || name.includes('COMMENT')) {
        return 'textarea';
    }
    
    return 'text';
}

// Create appropriate input element based on env var properties
function createEnvVarInput(envVar, id) {
    const inputType = determineInputType(envVar);
    const name = envVar.name || '';
    const label = envVar.label || name;
    const description = envVar.description || '';
    const defaultValue = envVar.default || envVar.set || '';
    const isPreset = envVar.preset === true;
    const isRequired = envVar.required === true || (envVar.default === undefined && envVar.set === undefined);
    const selectOptions = envVar.select || [];
    
    let valueInput = '';
    const presetClass = isPreset ? 'preset-field' : '';
    const readonlyAttr = isPreset ? 'readonly' : '';
    const requiredAttr = isRequired ? 'required' : '';
    const presetIcon = isPreset ? '<i class="fas fa-lock text-muted ms-2" title="Preset value"></i>' : '';
    
    switch (inputType) {
        case 'select':
            const options = selectOptions.map(opt => {
                const optValue = typeof opt === 'object' ? opt.value : opt;
                const optLabel = typeof opt === 'object' ? opt.text : opt;
                const selected = optValue === defaultValue ? 'selected' : '';
                return `<option value="${optValue}" ${selected}>${optLabel}</option>`;
            }).join('');
            valueInput = `
                <select class="form-select bg-dark text-white ${presetClass}" 
                        data-env-value="${id}" 
                        ${readonlyAttr} 
                        ${requiredAttr}
                        ${isPreset ? 'disabled' : ''}>
                    ${options}
                </select>
            `;
            break;
            
        case 'checkbox':
            const checked = (defaultValue === true || defaultValue === 'true' || String(defaultValue).toLowerCase() === 'true') ? 'checked' : '';
            valueInput = `
                <div class="form-check form-switch">
                    <input class="form-check-input" 
                           type="checkbox" 
                           data-env-value="${id}" 
                           ${checked}
                           ${readonlyAttr}
                           ${isPreset ? 'disabled' : ''}>
                </div>
            `;
            break;
            
        case 'password':
            valueInput = `
                <input type="password" 
                       class="form-control bg-dark text-white ${presetClass}" 
                       placeholder="Enter ${label.toLowerCase()}" 
                       data-env-value="${id}" 
                       value="${defaultValue}"
                       ${readonlyAttr}
                       ${requiredAttr}
                       ${isPreset ? 'disabled' : ''}>
            `;
            break;
            
        case 'number':
            const numValue = typeof defaultValue === 'number' ? defaultValue : (defaultValue ? parseFloat(defaultValue) : '');
            const min = envVar.min !== undefined ? envVar.min : (numValue !== '' ? Math.max(0, numValue - 100) : 0);
            const max = envVar.max !== undefined ? envVar.max : (numValue !== '' ? numValue + 100 : 1000);
            const step = envVar.step !== undefined ? envVar.step : 1;
            const useSlider = envVar.slider !== false && (max - min) <= 1000; // Use slider if range is reasonable
            
            if (useSlider) {
                valueInput = `
                    <div class="slider-container">
                        <input type="range" 
                               class="form-range slider-input" 
                               data-env-value="${id}" 
                               min="${min}"
                               max="${max}"
                               step="${step}"
                               value="${numValue || min}"
                               ${readonlyAttr}
                               ${isPreset ? 'disabled' : ''}
                               oninput="updateSliderValue('${id}', this.value)">
                        <div class="slider-value-display">
                            <input type="number" 
                                   class="form-control bg-dark text-white slider-number-input" 
                                   data-env-value="${id}" 
                                   value="${numValue || min}"
                                   min="${min}"
                                   max="${max}"
                                   step="${step}"
                                   ${readonlyAttr}
                                   ${requiredAttr}
                                   ${isPreset ? 'disabled' : ''}
                                   oninput="updateSliderRange('${id}', this.value, ${min}, ${max})">
                        </div>
                    </div>
                `;
            } else {
                valueInput = `
                    <input type="number" 
                           class="form-control bg-dark text-white ${presetClass}" 
                           placeholder="Enter ${label.toLowerCase()}" 
                           data-env-value="${id}" 
                           value="${numValue}"
                           min="${min}"
                           max="${max}"
                           step="${step}"
                           ${readonlyAttr}
                           ${requiredAttr}
                           ${isPreset ? 'disabled' : ''}>
                `;
            }
            break;
            
        case 'textarea':
            valueInput = `
                <textarea class="form-control bg-dark text-white ${presetClass}" 
                          placeholder="Enter ${label.toLowerCase()}" 
                          data-env-value="${id}" 
                          rows="3"
                          ${readonlyAttr}
                          ${requiredAttr}
                          ${isPreset ? 'disabled' : ''}>${defaultValue}</textarea>
            `;
            break;
            
        default: // text
            valueInput = `
                <input type="text" 
                       class="form-control bg-dark text-white ${presetClass}" 
                       placeholder="Enter ${label.toLowerCase()}" 
                       data-env-value="${id}" 
                       value="${defaultValue}"
                       ${readonlyAttr}
                       ${requiredAttr}
                       ${isPreset ? 'disabled' : ''}>
            `;
    }
    
    const descriptionHtml = description ? `<small class="text-muted d-block mt-1">${description}</small>` : '';
    const requiredIndicator = isRequired ? '<span class="text-danger">*</span>' : '';
    
    return `
        <div class="mb-3 env-var-item" data-env-name="${name}">
            <label class="form-label">
                ${label} ${requiredIndicator} ${presetIcon}
            </label>
            <input type="hidden" data-env-key="${id}" value="${name}" data-env-preset="${isPreset}">
            ${valueInput}
            ${descriptionHtml}
        </div>
    `;
}

function addEnvVar(envVar = null) {
    const container = document.getElementById('deploy-env');
    const id = `env-${envCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item mb-2';
    item.id = id;
    
    if (envVar) {
        // Use template-based input creation
        item.innerHTML = createEnvVarInput(envVar, id);
        // Add remove button if not preset
        if (!envVar.preset) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn btn-sm btn-outline-danger mt-2';
            removeBtn.innerHTML = '<i class="fas fa-times"></i> Remove';
            removeBtn.onclick = () => removeArrayItem(id);
            item.appendChild(removeBtn);
        }
    } else {
        // Default simple text inputs for manual addition
        item.innerHTML = `
            <input type="text" class="form-control bg-dark text-white" placeholder="KEY" data-env-key="${id}" style="flex: 0 0 40%;">
            <input type="text" class="form-control bg-dark text-white" placeholder="value" data-env-value="${id}" style="flex: 1;">
            <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
                <i class="fas fa-times"></i>
            </button>
        `;
    }
    
    container.appendChild(item);
    updatePreview();
}

function addLabel() {
    const container = document.getElementById('deploy-labels-container');
    const id = `label-${labelCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="key=value" data-label-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addDnsServer() {
    const container = document.getElementById('deploy-dns-container');
    const id = `dns-${dnsCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="8.8.8.8" data-dns-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addExtraHost() {
    const container = document.getElementById('deploy-extra-hosts-container');
    const id = `host-${extraHostCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="example.com:127.0.0.1" data-host-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addDeviceMapping() {
    const container = document.getElementById('deploy-devices-container');
    const id = `device-${deviceCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="/dev/ttyUSB0:/dev/ttyUSB0:rwm" data-device-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addCapability() {
    const container = document.getElementById('deploy-capabilities-container');
    const id = `cap-${capabilityCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="NET_ADMIN" data-cap-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addSecurityOpt() {
    const container = document.getElementById('deploy-security-opts-container');
    const id = `secopt-${securityOptCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="apparmor=profile" data-secopt-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addLogOpt() {
    const container = document.getElementById('deploy-log-opts-container');
    const id = `logopt-${logOptCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="max-size=10m" data-logopt-key="${id}" style="flex: 0 0 40%;">
        <input type="text" class="form-control bg-dark text-white" placeholder="value" data-logopt-value="${id}" style="flex: 1;">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addSysctl() {
    const container = document.getElementById('deploy-sysctls-container');
    const id = `sysctl-${sysctlCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="net.ipv4.ip_forward=1" data-sysctl-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function addUlimit() {
    const container = document.getElementById('deploy-ulimits-container');
    const id = `ulimit-${ulimitCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="nofile=1024:2048" data-ulimit-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    updatePreview();
}

function removeArrayItem(id) {
    const item = document.getElementById(id);
    if (item) {
        item.remove();
        updatePreview();
    }
}

// Slider helper functions
function updateSliderValue(id, value) {
    const numberInput = document.querySelector(`[data-env-value="${id}"].slider-number-input`);
    if (numberInput) {
        numberInput.value = value;
    }
    updatePreview();
}

function updateSliderRange(id, value, min, max) {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return;
    
    const clampedValue = Math.max(min, Math.min(max, numValue));
    const sliderInput = document.querySelector(`[data-env-value="${id}"].slider-input`);
    const numberInput = document.querySelector(`[data-env-value="${id}"].slider-number-input`);
    
    if (sliderInput) {
        sliderInput.value = clampedValue;
    }
    if (numberInput) {
        numberInput.value = clampedValue;
    }
    updatePreview();
}

// Make functions globally available
window.addPortMapping = addPortMapping;
window.validatePortMapping = validatePortMapping;
window.addVolumeMount = addVolumeMount;
window.handleVolumeTypeChange = handleVolumeTypeChange;
window.validateVolumeMount = validateVolumeMount;
window.openFileBrowser = openFileBrowser;

// Simplified volumes selector - use centralized cache from app.js
// Track which select elements are waiting for volumes
const pendingVolumeSelects = new Set();

// Store active volume handlers to prevent them from being replaced
const activeVolumeHandlers = new Map();
// Expose to window for app.js to access
window.activeVolumeHandlers = activeVolumeHandlers;

// Simplified load volumes for named volume select
async function loadVolumesForSelect(volumeId) {
    const namedSelect = document.querySelector(`[data-volume-named="${volumeId}"]`);
    if (!namedSelect) {
        console.error('[ERROR] Named volume select element not found for ID:', volumeId);
        return;
    }
    
    // Check if already has volumes loaded (more than just placeholder)
    const hasVolumeOptions = Array.from(namedSelect.options).some(opt => opt.value && opt.value !== '');
    if (hasVolumeOptions && namedSelect.options.length > 1) {
        return; // Already loaded
    }
    
    // Check if already in pending list
    if (pendingVolumeSelects.has(volumeId)) {
        return; // Already loading
    }
    
    // Check cache first - if we have volumes in cache, use them immediately
    if (window.volumesStore && !window.volumesStore.isStale() && window.volumesStore.get().length > 0) {
        populateVolumeSelect(volumeId, window.volumesStore.get());
        return;
    }
    
    try {
        // Mark as pending
        pendingVolumeSelects.add(volumeId);
        
        // Show loading state
        const currentValue = namedSelect.value;
        namedSelect.innerHTML = '<option value="">Loading volumes...</option>';
        namedSelect.disabled = true;
        
        // Set up handler to populate select when volumes arrive
        const handlerState = {
            volumesReceived: false,
            volumeId: volumeId,
            startTime: Date.now()
        };
        
        const volumeHandler = (response) => {
            // Check if this is a volumes response
            let volumesArray = null;
            if (response && response.type === 'volumes' && Array.isArray(response.data)) {
                volumesArray = response.data;
            } else if (response && response.success === true && Array.isArray(response.volumes)) {
                volumesArray = response.volumes;
            } else if (response && Array.isArray(response.volumes)) {
                volumesArray = response.volumes;
            }
            
            // If not a volumes response, ignore
            if (volumesArray === null) {
                return;
            }
            
            // Only process once per handler
            if (handlerState.volumesReceived) {
                return;
            }
            
            handlerState.volumesReceived = true;
            pendingVolumeSelects.delete(volumeId);
            activeVolumeHandlers.delete(volumeId);
            
            // Restore original handler if needed
            if (window.handlePeerResponse === volumeHandler && handlerState.originalHandler) {
                window.handlePeerResponse = handlerState.originalHandler;
            }
            
            // Populate the select
            populateVolumeSelect(volumeId, volumesArray);
        };
        
        // Store original handler
        handlerState.originalHandler = window.handlePeerResponse;
        
        // Set up handler
        window.handlePeerResponse = volumeHandler;
        activeVolumeHandlers.set(volumeId, {
            handler: volumeHandler,
            state: handlerState,
            originalHandler: handlerState.originalHandler
        });
        
        // Subscribe to cache updates as fallback
        let unsubscribe = null;
        if (window.volumesStore) {
            unsubscribe = window.volumesStore.subscribe((volumes) => {
                if (volumes.length > 0 && pendingVolumeSelects.has(volumeId)) {
                    pendingVolumeSelects.delete(volumeId);
                    activeVolumeHandlers.delete(volumeId);
                    if (window.handlePeerResponse === volumeHandler && handlerState.originalHandler) {
                        window.handlePeerResponse = handlerState.originalHandler;
                    }
                    if (unsubscribe) {
                        unsubscribe();
                    }
                    populateVolumeSelect(volumeId, volumes);
                }
            });
        }
        
        // Request volumes from server
        if (typeof window.sendCommand !== 'function') {
            console.error('[ERROR] sendCommand function not available');
            namedSelect.innerHTML = '<option value="">Error: Cannot communicate with server</option>';
            namedSelect.disabled = false;
            pendingVolumeSelects.delete(volumeId);
            activeVolumeHandlers.delete(volumeId);
            if (window.handlePeerResponse === volumeHandler && handlerState.originalHandler) {
                window.handlePeerResponse = handlerState.originalHandler;
            }
            return;
        }
        
        window.sendCommand('listVolumes');
        
        // Timeout after 10 seconds
        setTimeout(() => {
            if (pendingVolumeSelects.has(volumeId)) {
                pendingVolumeSelects.delete(volumeId);
                activeVolumeHandlers.delete(volumeId);
                if (window.handlePeerResponse === volumeHandler && handlerState.originalHandler) {
                    window.handlePeerResponse = handlerState.originalHandler;
                }
                
                const currentSelect = document.querySelector(`[data-volume-named="${volumeId}"]`);
                if (currentSelect) {
                    currentSelect.innerHTML = '<option value="">Request timed out - click to retry</option>';
                    currentSelect.disabled = false;
                }
            }
        }, 10000);
        
    } catch (error) {
        console.error('[ERROR] Failed to load volumes:', error);
        pendingVolumeSelects.delete(volumeId);
        activeVolumeHandlers.delete(volumeId);
        const currentSelect = document.querySelector(`[data-volume-named="${volumeId}"]`);
        if (currentSelect) {
            currentSelect.innerHTML = '<option value="">Error loading volumes</option>';
            currentSelect.disabled = false;
        }
    }
}

// Helper function to populate volume select dropdown
function populateVolumeSelect(volumeId, volumesArray) {
    const namedSelect = document.querySelector(`[data-volume-named="${volumeId}"]`);
    if (!namedSelect) {
        return;
    }
    
    const currentValue = namedSelect.value;
    
    // Clear and rebuild options
    namedSelect.innerHTML = '';
    
    // Add placeholder option
    const placeholderOption = new Option('Select or create volume...', '', true, false);
    namedSelect.add(placeholderOption);
    
    // Add volumes
    if (!volumesArray || volumesArray.length === 0) {
        const option = new Option('No volumes available', '', false, true);
        option.disabled = true;
        namedSelect.add(option);
    } else {
        volumesArray.forEach((volume) => {
            const volumeName = volume.Name || volume.name || (typeof volume === 'string' ? volume : null);
            if (volumeName) {
                const option = new Option(volumeName, volumeName, false, false);
                namedSelect.add(option);
            }
        });
    }
    
    // Restore previous selection if it still exists
    if (currentValue && Array.from(namedSelect.options).some(opt => opt.value === currentValue)) {
        namedSelect.value = currentValue;
    }
    
    namedSelect.disabled = false;
}

// Expose loadVolumesForSelect to window for inline handlers
window.loadVolumesForSelect = loadVolumesForSelect;

// Open file browser modal
let currentFileBrowserVolumeId = null;
let currentFileBrowserPath = '/';

function openFileBrowser(volumeId) {
    currentFileBrowserVolumeId = volumeId;
    currentFileBrowserPath = '/';
    
    const fileBrowserModal = document.getElementById('fileBrowserModal');
    if (!fileBrowserModal) {
        console.error('[ERROR] File browser modal element not found');
        return;
    }
    
    if (typeof bootstrap === 'undefined') {
        console.error('[ERROR] Bootstrap is not available');
        return;
    }
    
    try {
        const modal = new bootstrap.Modal(fileBrowserModal);
        modal.show();
        loadDirectoryContents('/');
    } catch (error) {
        console.error('[ERROR] Failed to open file browser modal:', error);
    }
}

// Load directory contents
async function loadDirectoryContents(path) {
    const fileBrowserContent = document.getElementById('fileBrowserContent');
    const fileBrowserBreadcrumb = document.getElementById('fileBrowserBreadcrumb');
    
    if (!fileBrowserContent) {
        console.error('[ERROR] File browser content element not found');
        return;
    }
    
    // Show loading
    fileBrowserContent.innerHTML = '<div class="text-center p-4"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
    
    // Update breadcrumb
    if (fileBrowserBreadcrumb) {
        const pathParts = path.split('/').filter(p => p);
        let breadcrumbHtml = '<nav aria-label="breadcrumb"><ol class="breadcrumb mb-0">';
        breadcrumbHtml += '<li class="breadcrumb-item"><a href="#" onclick="loadDirectoryContents(\'/\'); return false;"><i class="fas fa-home"></i> Root</a></li>';
        
        let currentPath = '';
        pathParts.forEach((part, index) => {
            currentPath += '/' + part;
            const isLast = index === pathParts.length - 1;
            breadcrumbHtml += `<li class="breadcrumb-item ${isLast ? 'active' : ''}">`;
            if (!isLast) {
                breadcrumbHtml += `<a href="#" onclick="loadDirectoryContents('${currentPath}'); return false;">${part}</a>`;
            } else {
                breadcrumbHtml += part;
            }
            breadcrumbHtml += '</li>';
        });
        breadcrumbHtml += '</ol></nav>';
        fileBrowserBreadcrumb.innerHTML = breadcrumbHtml;
    }
    
    try {
        if (typeof window.sendCommand !== 'function') {
            console.error('[ERROR] sendCommand function not available');
            fileBrowserContent.innerHTML = '<div class="alert alert-danger">Error: Cannot communicate with server</div>';
            return;
        }
        
        // Store original handler
        const originalHandler = window.handlePeerResponse;
        let directoryReceived = false;
        const requestId = `browseDir_${Date.now()}_${Math.random()}`;
        
        const directoryHandler = (response) => {
            // Check if this is a directory browser response
            // Look for: success + contents, or error related to directory browsing
            const isDirectoryResponse = 
                (response.success === true && Array.isArray(response.contents)) ||
                (response.error && (response.error.includes('directory') || response.error.includes('browse'))) ||
                (response.path && response.contents !== undefined);
            
            if (!isDirectoryResponse) {
                // Not a directory response, pass to original handler
                if (typeof originalHandler === 'function') {
                    originalHandler(response);
                }
                return;
            }
            
            if (directoryReceived) {
                // Already processed, pass to original handler
                if (typeof originalHandler === 'function') {
                    originalHandler(response);
                }
                return;
            }
            
            // Handle success response
            if (response.success === true && Array.isArray(response.contents)) {
                directoryReceived = true;
                window.handlePeerResponse = originalHandler;
                currentFileBrowserPath = response.path || path;
                displayDirectoryContents(response.contents, currentFileBrowserPath);
            } 
            // Handle error response
            else if (response.error) {
                directoryReceived = true;
                window.handlePeerResponse = originalHandler;
                console.error('[ERROR] Directory browse error:', response.error);
                fileBrowserContent.innerHTML = `<div class="alert alert-danger"><i class="fas fa-exclamation-triangle"></i> Error: ${response.error}</div>`;
            }
            // Handle unexpected format
            else {
                console.warn('[WARN] Unexpected response format:', response);
                // Still try to process if it has contents
                if (response.contents !== undefined) {
                    directoryReceived = true;
                    window.handlePeerResponse = originalHandler;
                    currentFileBrowserPath = response.path || path;
                    displayDirectoryContents(response.contents || [], currentFileBrowserPath);
                } else {
                    // Pass to original handler if we can't process it
                    if (typeof originalHandler === 'function') {
                        originalHandler(response);
                    }
                }
            }
        };
        
        // Set the handler
        window.handlePeerResponse = directoryHandler;
        
        // Send the command
        window.sendCommand('browseDirectory', { path: path });
        
        // Timeout after 10 seconds
        const timeoutId = setTimeout(() => {
            if (!directoryReceived) {
                console.warn('[WARN] Directory browse request timed out');
                window.handlePeerResponse = originalHandler;
                directoryReceived = true; // Mark as received to prevent double handling
                fileBrowserContent.innerHTML = '<div class="alert alert-warning"><i class="fas fa-clock"></i> Request timed out. Please try again.</div>';
            }
        }, 10000);
        
        // Store timeout ID for potential cleanup (though we don't need it after timeout)
        // This is just for reference
        
    } catch (error) {
        console.error('[ERROR] Failed to load directory:', error);
        fileBrowserContent.innerHTML = `<div class="alert alert-danger"><i class="fas fa-exclamation-triangle"></i> Error: ${error.message}</div>`;
    }
}

// Display directory contents
function displayDirectoryContents(contents, currentPath) {
    const fileBrowserContent = document.getElementById('fileBrowserContent');
    if (!fileBrowserContent) {
        console.error('[ERROR] File browser content element not found');
        return;
    }
    
    if (!contents || contents.length === 0) {
        fileBrowserContent.innerHTML = '<div class="text-center p-4 text-muted"><i class="fas fa-folder-open"></i> Directory is empty</div>';
        return;
    }
    
    // Sort: directories first, then files
    const sorted = contents.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return (a.name || '').localeCompare(b.name || '');
    });
    
    let html = '<div class="file-browser-list">';
    sorted.forEach(item => {
        const icon = item.type === 'directory' ? 'fa-folder' : 'fa-file';
        const iconColor = item.type === 'directory' ? 'text-warning' : 'text-secondary';
        // Escape path for onclick to prevent XSS
        const escapedPath = (currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`)
            .replace(/'/g, "\\'")
            .replace(/"/g, '&quot;');
        const escapedName = (item.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        if (item.type === 'directory') {
            html += `
                <div class="file-browser-item" onclick="loadDirectoryContents('${escapedPath}')" title="Click to open">
                    <i class="fas ${icon} ${iconColor}"></i>
                    <span>${escapedName}</span>
                    <i class="fas fa-chevron-right text-muted"></i>
                </div>
            `;
        } else {
            const size = item.size ? formatFileSize(item.size) : '';
            html += `
                <div class="file-browser-item" title="File${size ? ': ' + size : ''}">
                    <i class="fas ${icon} ${iconColor}"></i>
                    <span>${escapedName}</span>
                    ${size ? `<small class="text-muted ms-2">${size}</small>` : ''}
                </div>
            `;
        }
    });
    html += '</div>';
    
    fileBrowserContent.innerHTML = html;
}

// Helper function to format file size
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Select directory for volume mount
function selectDirectoryForVolume() {
    if (!currentFileBrowserVolumeId) {
        console.warn('[WARN] No volume ID set for directory selection');
        return;
    }
    
    const hostInput = document.querySelector(`[data-volume-host="${currentFileBrowserVolumeId}"]`);
    if (hostInput) {
        hostInput.value = currentFileBrowserPath;
        validateVolumeMount(currentFileBrowserVolumeId);
        updatePreview();
    } else {
        console.error('[ERROR] Host input not found for volume ID:', currentFileBrowserVolumeId);
    }
    
    // Close modal
    const fileBrowserModal = document.getElementById('fileBrowserModal');
    if (fileBrowserModal && typeof bootstrap !== 'undefined') {
        try {
            const modal = bootstrap.Modal.getInstance(fileBrowserModal);
            if (modal) {
                modal.hide();
            }
        } catch (error) {
            console.error('[ERROR] Failed to close file browser modal:', error);
        }
    }
}

window.loadDirectoryContents = loadDirectoryContents;
window.selectDirectoryForVolume = selectDirectoryForVolume;
window.addTmpfsMount = addTmpfsMount;
window.addEnvVar = addEnvVar;
window.addLabel = addLabel;
window.addDnsServer = addDnsServer;
window.addExtraHost = addExtraHost;
window.addDeviceMapping = addDeviceMapping;
window.addCapability = addCapability;
window.addSecurityOpt = addSecurityOpt;
window.addLogOpt = addLogOpt;
window.addSysctl = addSysctl;
window.addUlimit = addUlimit;
window.removeArrayItem = removeArrayItem;
window.updateSliderValue = updateSliderValue;
window.updateSliderRange = updateSliderRange;

// Network mode change handler
document.addEventListener('DOMContentLoaded', () => {
    const networkMode = document.getElementById('deploy-network-mode');
    const customNetworkContainer = document.getElementById('deploy-custom-network-container');
    if (networkMode && customNetworkContainer) {
        networkMode.addEventListener('change', (e) => {
            if (e.target.value === 'container') {
                customNetworkContainer.style.display = 'block';
                const input = customNetworkContainer.querySelector('input');
                if (input) input.placeholder = 'container-name';
            } else if (e.target.value !== 'host' && e.target.value !== 'none' && e.target.value !== 'bridge') {
                customNetworkContainer.style.display = 'block';
                const input = customNetworkContainer.querySelector('input');
                if (input) input.placeholder = 'network-name';
            } else {
                customNetworkContainer.style.display = 'none';
            }
            updatePreview();
        });
    }

    // Add input listeners for preview updates
    const form = document.getElementById('deploy-form');
    if (form) {
        form.addEventListener('input', () => updatePreview());
        form.addEventListener('change', () => updatePreview());
    }
});

// Collect all form data
function collectFormData() {
    const data = {
        containerName: document.getElementById('deploy-container-name')?.value.trim() || '',
        image: document.getElementById('deploy-image')?.value.trim() || '',
        command: document.getElementById('deploy-command')?.value.trim() || null,
        entrypoint: document.getElementById('deploy-entrypoint')?.value.trim() || null,
        workingDir: document.getElementById('deploy-workdir')?.value.trim() || null,
        
        // Networking
        networkMode: document.getElementById('deploy-network-mode')?.value || 'bridge',
        customNetwork: (() => {
            const mode = document.getElementById('deploy-network-mode')?.value;
            const customNet = document.getElementById('deploy-custom-network')?.value.trim();
            if ((mode === 'container' || (mode && mode !== 'bridge' && mode !== 'host' && mode !== 'none')) && customNet) {
                return customNet;
            }
            return null;
        })(),
        hostname: document.getElementById('deploy-hostname')?.value.trim() || null,
        domainname: document.getElementById('deploy-domainname')?.value.trim() || null,
        ports: collectPortMappings(),
        dns: collectArrayItems('deploy-dns-container', 'data-dns-id'),
        extraHosts: collectArrayItems('deploy-extra-hosts-container', 'data-host-id'),
        
        // Volumes
        volumes: collectVolumeMounts(),
        tmpfs: collectArrayItems('deploy-tmpfs-container', 'data-tmpfs-id'),
        
        // Resources
        cpuLimit: parseFloat(document.getElementById('deploy-cpu-limit')?.value) || null,
        cpuReservation: parseFloat(document.getElementById('deploy-cpu-reservation')?.value) || null,
        cpuShares: parseInt(document.getElementById('deploy-cpu-shares')?.value) || null,
        memoryLimit: parseInt(document.getElementById('deploy-memory-limit')?.value) || null,
        memoryReservation: parseInt(document.getElementById('deploy-memory-reservation')?.value) || null,
        memorySwap: parseInt(document.getElementById('deploy-memory-swap')?.value) || null,
        devices: collectArrayItems('deploy-devices-container', 'data-device-id'),
        
        // Environment & Labels
        env: collectEnvVars(),
        labels: collectLabels(),
        
        // Security
        user: document.getElementById('deploy-user')?.value.trim() || null,
        group: document.getElementById('deploy-group')?.value.trim() || null,
        privileged: document.getElementById('deploy-privileged')?.checked || false,
        readonlyRootfs: document.getElementById('deploy-readonly-rootfs')?.checked || false,
        capabilities: collectArrayItems('deploy-capabilities-container', 'data-cap-id'),
        securityOpts: collectArrayItems('deploy-security-opts-container', 'data-secopt-id'),
        
        // Runtime
        restartPolicy: document.getElementById('deploy-restart-policy')?.value || 'no',
        restartMaxRetries: parseInt(document.getElementById('deploy-restart-max-retries')?.value) || null,
        autoRemove: document.getElementById('deploy-auto-remove')?.checked || false,
        tty: document.getElementById('deploy-tty')?.checked || false,
        stdinOpen: document.getElementById('deploy-stdin-open')?.checked || false,
        detach: document.getElementById('deploy-detach')?.checked !== false, // Default true
        init: document.getElementById('deploy-init')?.checked || false,
        
        // Health & Logging
        healthCmd: document.getElementById('deploy-health-cmd')?.value.trim() || null,
        healthInterval: parseInt(document.getElementById('deploy-health-interval')?.value) || null,
        healthTimeout: parseInt(document.getElementById('deploy-health-timeout')?.value) || null,
        healthRetries: parseInt(document.getElementById('deploy-health-retries')?.value) || null,
        healthStartPeriod: parseInt(document.getElementById('deploy-health-start-period')?.value) || null,
        logDriver: document.getElementById('deploy-log-driver')?.value || null,
        logOpts: collectLogOpts(),
        
        // Advanced
        sysctls: collectSysctls(),
        ulimits: collectUlimits(),
        oomKillDisable: document.getElementById('deploy-oom-kill-disable')?.checked || false,
        pidsLimit: parseInt(document.getElementById('deploy-pids-limit')?.value) || null,
        shmSize: parseInt(document.getElementById('deploy-shm-size')?.value) || null,
    };
    
    // Remove null/empty values
    Object.keys(data).forEach(key => {
        if (data[key] === null || data[key] === '' || (Array.isArray(data[key]) && data[key].length === 0)) {
            delete data[key];
        }
    });
    
    return data;
}

function collectArrayItems(containerId, dataAttr) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const items = [];
    container.querySelectorAll(`[${dataAttr}]`).forEach(input => {
        const value = input.value.trim();
        if (value) items.push(value);
    });
    return items;
}

// Collect port mappings from structured inputs
function collectPortMappings() {
    const container = document.getElementById('deploy-ports-container');
    if (!container) return [];
    const ports = [];
    
    container.querySelectorAll('.port-mapping-item').forEach(item => {
        const hostInput = item.querySelector('.port-host-input');
        const containerInput = item.querySelector('.port-container-input');
        const protocolInput = item.querySelector('.port-protocol-input');
        
        if (!containerInput || !containerInput.value) return;
        
        const hostPort = hostInput?.value.trim() || '';
        const containerPort = containerInput.value.trim();
        const protocol = protocolInput?.value || 'tcp';
        
        // Build port string: host:container/protocol or container/protocol
        const portStr = hostPort ? `${hostPort}:${containerPort}/${protocol}` : `${containerPort}/${protocol}`;
        ports.push(portStr);
    });
    
    return ports;
}

// Collect volume mounts from structured inputs
function collectVolumeMounts() {
    const container = document.getElementById('deploy-volumes-container');
    if (!container) return [];
    const volumes = [];
    
    container.querySelectorAll('.volume-mount-item').forEach(item => {
        const typeSelect = item.querySelector('.volume-type-input');
        const hostInput = item.querySelector('.volume-host-input');
        const namedSelect = item.querySelector('.volume-named-input');
        const containerInput = item.querySelector('.volume-container-input');
        const modeSelect = item.querySelector('.volume-mode-input');
        
        if (!containerInput || !containerInput.value) return;
        
        const volumeType = typeSelect?.value || 'bind';
        const containerPath = containerInput.value.trim();
        const mountMode = modeSelect?.value || 'rw';
        
        let volumeStr = '';
        
        if (volumeType === 'bind') {
            const hostPath = hostInput?.value.trim() || '';
            if (!hostPath) return; // Skip if host path is empty
            volumeStr = `${hostPath}:${containerPath}:${mountMode}`;
        } else {
            // Named volume
            const volumeName = namedSelect?.value.trim() || '';
            if (!volumeName) return; // Skip if volume name is empty
            volumeStr = `${volumeName}:${containerPath}:${mountMode}`;
        }
        
        volumes.push(volumeStr);
    });
    
    return volumes;
}

function collectEnvVars() {
    const container = document.getElementById('deploy-env');
    if (!container) return [];
    const envVars = [];
    
    container.querySelectorAll('[data-env-key]').forEach(keyInput => {
        const key = keyInput.value.trim();
        if (!key) return;
        
        const id = keyInput.getAttribute('data-env-key');
        const isPreset = keyInput.getAttribute('data-env-preset') === 'true';
        
        // Find the value input/select/checkbox
        const valueInput = container.querySelector(`[data-env-value="${id}"]`);
        if (!valueInput) return;
        
        let value = '';
        
        // Handle different input types
        if (valueInput.type === 'checkbox') {
            // For checkboxes, use 'true' or 'false' as string
            value = valueInput.checked ? 'true' : 'false';
        } else if (valueInput.tagName === 'SELECT') {
            value = valueInput.value || '';
        } else if (valueInput.tagName === 'TEXTAREA') {
            value = valueInput.value.trim();
        } else if (valueInput.type === 'range') {
            // For sliders, get the number input value
            const numberInput = container.querySelector(`[data-env-value="${id}"].slider-number-input`);
            value = numberInput ? String(numberInput.value).trim() : String(valueInput.value);
        } else if (valueInput.type === 'number') {
            // For number inputs, preserve the numeric value as string
            value = valueInput.value !== '' ? String(valueInput.value).trim() : '';
        } else {
            value = valueInput.value.trim();
        }
        
        // Include preset values even if disabled
        if (isPreset || value) {
            envVars.push({ 
                name: key, 
                value: value || '',
                preset: isPreset 
            });
        }
    });
    
    return envVars;
}

function collectLabels() {
    const items = collectArrayItems('deploy-labels-container', 'data-label-id');
    const labels = {};
    items.forEach(item => {
        const [key, value] = item.split('=');
        if (key && value) {
            labels[key.trim()] = value.trim();
        }
    });
    return Object.keys(labels).length > 0 ? labels : null;
}

function collectLogOpts() {
    const container = document.getElementById('deploy-log-opts-container');
    if (!container) return null;
    const opts = {};
    container.querySelectorAll('[data-logopt-key]').forEach(keyInput => {
        const key = keyInput.value.trim();
        const valueInput = container.querySelector(`[data-logopt-value="${keyInput.getAttribute('data-logopt-key')}"]`);
        const value = valueInput?.value.trim() || '';
        if (key) {
            opts[key] = value;
        }
    });
    return Object.keys(opts).length > 0 ? opts : null;
}

function collectSysctls() {
    const items = collectArrayItems('deploy-sysctls-container', 'data-sysctl-id');
    const sysctls = {};
    items.forEach(item => {
        const [key, value] = item.split('=');
        if (key && value) {
            sysctls[key.trim()] = value.trim();
        }
    });
    return Object.keys(sysctls).length > 0 ? sysctls : null;
}

function collectUlimits() {
    const items = collectArrayItems('deploy-ulimits-container', 'data-ulimit-id');
    const ulimits = [];
    items.forEach(item => {
        const [name, limits] = item.split('=');
        if (name && limits) {
            const [soft, hard] = limits.split(':');
            ulimits.push({
                Name: name.trim(),
                Soft: soft ? parseInt(soft) : null,
                Hard: hard ? parseInt(hard) : null
            });
        }
    });
    return ulimits.length > 0 ? ulimits : null;
}

// Update preview
function updatePreview() {
    const previewContainer = document.getElementById('deploy-preview-container');
    const preview = document.getElementById('deploy-preview');
    const showPreview = document.getElementById('deploy-show-preview')?.checked;
    
    if (!previewContainer || !preview) return;
    
    if (showPreview) {
        const data = collectFormData();
        preview.textContent = JSON.stringify(data, null, 2);
        previewContainer.style.display = 'block';
    } else {
        previewContainer.style.display = 'none';
    }
}

window.togglePreview = updatePreview;

// Open deploy modal and populate the form dynamically
function openDeployModal(template) {
    // CRITICAL: Log immediately at function entry - this should ALWAYS show
    console.log('[CRITICAL] openDeployModal FUNCTION ENTRY - template:', template);
    console.log('[CRITICAL] template type:', typeof template);
    console.log('[CRITICAL] template is null?', template === null);
    console.log('[CRITICAL] template is undefined?', template === undefined);
    
    // Validate template object
    if (!template || typeof template !== 'object') {
        console.error('[ERROR] Invalid template provided to openDeployModal:', template);
        showAlert('danger', 'Invalid template data. Please try again.');
        return;
    }
    
    // Initialize template deployer lazily (DOM elements, modal, event listeners)
    initTemplateDeployer();
    
    // Store current template for validation
    currentTemplate = template;
    
    // Reset counters
    portCounter = volumeCounter = envCounter = labelCounter = dnsCounter = 0;
    extraHostCounter = deviceCounter = capabilityCounter = securityOptCounter = 0;
    logOptCounter = sysctlCounter = ulimitCounter = tmpfsCounter = 0;
    
    // Set the modal title
    const deployTitle = document.getElementById('deploy-title');
    if (deployTitle) {
        deployTitle.textContent = `Deploy ${template.title || 'Template'}`;
    }

    // Clear all form fields
    const form = document.getElementById('deploy-form');
    if (form) form.reset();
    
    // Clear all array containers
    ['deploy-ports-container', 'deploy-volumes-container', 'deploy-env', 'deploy-labels-container',
     'deploy-dns-container', 'deploy-extra-hosts-container', 'deploy-devices-container',
     'deploy-capabilities-container', 'deploy-security-opts-container', 'deploy-log-opts-container',
     'deploy-sysctls-container', 'deploy-ulimits-container', 'deploy-tmpfs-container'].forEach(id => {
        const container = document.getElementById(id);
        if (container) container.innerHTML = '';
    });

    // Populate basic fields
    try {
        const deployImage = document.getElementById('deploy-image');
        if (deployImage && template.image) {
            deployImage.value = String(template.image);
        }
        
        // Populate command if present
        if (template.command) {
            const deployCommand = document.getElementById('deploy-command');
            if (deployCommand) {
                if (typeof template.command === 'string') {
                    deployCommand.value = template.command;
                    console.log('[DEBUG] Command set to:', template.command);
                } else if (Array.isArray(template.command)) {
                    deployCommand.value = template.command.join(' ');
                    console.log('[DEBUG] Command set to (from array):', deployCommand.value);
                }
            } else {
                console.warn('[WARN] Command element not found');
            }
        } else {
            console.log('[DEBUG] No command property found in template');
        }
        
        // Populate interactive/TTY settings
        console.log('[DEBUG] Checking template.interactive:', template.interactive);
        if (template.interactive !== undefined) {
            const deployTty = document.getElementById('deploy-tty');
            const deployStdinOpen = document.getElementById('deploy-stdin-open');
            if (deployTty && template.interactive) {
                deployTty.checked = true;
                console.log('[DEBUG] TTY checked set to true');
            }
            if (deployStdinOpen && template.interactive) {
                deployStdinOpen.checked = true;
                console.log('[DEBUG] Stdin open checked set to true');
            }
        } else {
            console.log('[DEBUG] No interactive property found in template');
        }
    } catch (error) {
        console.error('[ERROR] Failed to populate basic template fields:', error);
    }

    // Function to populate ports (will be called after modal is shown)
    const populatePorts = () => {
        console.log('[DEBUG] ===== populatePorts FUNCTION CALLED =====');
        console.log('[DEBUG] populatePorts called - Checking template.ports:', template.ports, 'Type:', typeof template.ports, 'IsArray:', Array.isArray(template.ports));
        console.log('[DEBUG] Full template object in populatePorts:', template);
        
        if (template.ports) {
            try {
                // Handle both array and single port value
                const portsArray = Array.isArray(template.ports) ? template.ports : [template.ports];
                console.log('[DEBUG] Processing ports array:', portsArray, 'Length:', portsArray.length);
                
                // Check if ports container exists
                const portsContainer = document.getElementById('deploy-ports-container');
                console.log('[DEBUG] Ports container element:', portsContainer ? 'Found' : 'NOT FOUND');
                
                if (!portsContainer) {
                    console.error('[ERROR] Ports container not found when trying to populate ports');
                    return;
                }
                
                portsArray.forEach((port, index) => {
                    console.log(`[DEBUG] Processing port at index ${index}:`, port, 'Type:', typeof port, 'IsNull:', port === null, 'IsUndefined:', port === undefined);
                    
                    if (port != null && port !== undefined) {
                        let portValue;
                        
                        // Handle different port formats
                        if (typeof port === 'string') {
                            portValue = port.trim();
                        } else if (typeof port === 'number') {
                            portValue = String(port);
                        } else if (typeof port === 'object') {
                            // Port might be an object with properties like { container: "5000", protocol: "tcp" }
                            console.log('[DEBUG] Port is an object, checking structure:', port);
                            if (port.container || port.target) {
                                const containerPort = port.container || port.target;
                                const protocol = port.protocol || 'tcp';
                                const hostPort = port.host || port.published || '';
                                if (hostPort) {
                                    portValue = `${hostPort}:${containerPort}/${protocol}`;
                                } else {
                                    portValue = `${containerPort}/${protocol}`;
                                }
                            } else {
                                console.warn(`[WARN] Port object at index ${index} has unexpected structure:`, port);
                                portValue = String(port); // Fallback
                            }
                        } else {
                            portValue = String(port);
                        }
                        
                        console.log(`[DEBUG] Converted port ${index} to:`, portValue);
                        
                        if (portValue && portValue.trim()) {
                            addPortMapping(portValue);
                        } else {
                            console.warn(`[WARN] Port ${index} converted to empty string, skipping`);
                        }
                    } else {
                        console.warn(`[WARN] Skipping null/undefined port at index ${index}`);
                    }
                });
                
                // Verify ports were added
                setTimeout(() => {
                    const portsAfter = document.getElementById('deploy-ports-container');
                    if (portsAfter) {
                        const portItems = portsAfter.querySelectorAll('.port-mapping-item');
                        console.log('[DEBUG] Ports added to DOM:', portItems.length, 'Expected:', portsArray.length);
                    }
                }, 100);
            } catch (error) {
                console.error('[ERROR] Failed to populate ports from template:', error);
                console.error('[ERROR] Error stack:', error.stack);
            }
        } else {
            console.log('[DEBUG] No ports property found in template');
        }
    };
    
    // Try to populate ports immediately (in case modal is already rendered)
    console.log('[DEBUG] About to call populatePorts() function');
    populatePorts();
    console.log('[DEBUG] populatePorts() function call completed');

    // Populate volumes from template
    console.log('[DEBUG] Checking template.volumes:', template.volumes, 'Type:', typeof template.volumes, 'IsArray:', Array.isArray(template.volumes));
    if (template.volumes) {
        try {
            // Handle both array and single volume value
            const volumesArray = Array.isArray(template.volumes) ? template.volumes : [template.volumes];
            console.log('[DEBUG] Processing volumes array:', volumesArray, 'Length:', volumesArray.length);
            
            volumesArray.forEach((volume, index) => {
                if (volume != null) {
                    let volumeStr = '';
                    if (typeof volume === 'object' && volume.bind && volume.container) {
                        volumeStr = `${volume.bind}:${volume.container}${volume.mode ? ':' + volume.mode : ''}`;
                    } else if (typeof volume === 'string') {
                        volumeStr = volume;
                    }
                    if (volumeStr) {
                        console.log(`[DEBUG] Adding volume ${index}:`, volumeStr);
                        addVolumeMount(volumeStr);
                    } else {
                        console.warn(`[WARN] Skipping invalid volume at index ${index}:`, volume);
                    }
                }
            });
            
            // Verify volumes were added
            setTimeout(() => {
                const volumesContainer = document.getElementById('deploy-volumes-container');
                if (volumesContainer) {
                    const volumeItems = volumesContainer.querySelectorAll('.volume-mount-item');
                    console.log('[DEBUG] Volumes added to DOM:', volumeItems.length, 'Expected:', volumesArray.length);
                }
            }, 100);
        } catch (error) {
            console.error('[ERROR] Failed to populate volumes from template:', error);
        }
    } else {
        console.log('[DEBUG] No volumes property found in template');
    }

    // Populate environment variables from template
    console.log('[DEBUG] Checking template.env:', template.env, 'Type:', typeof template.env, 'IsArray:', Array.isArray(template.env));
    if (template.env) {
        try {
            // Handle both array and single env value
            const envArray = Array.isArray(template.env) ? template.env : [template.env];
            console.log('[DEBUG] Processing env array:', envArray, 'Length:', envArray.length);
            
            envArray.forEach((env, index) => {
                if (env != null) {
                    console.log(`[DEBUG] Adding env var ${index}:`, env);
                    addEnvVar(env);
                } else {
                    console.warn(`[WARN] Skipping null/undefined env var at index ${index}`);
                }
            });
            
            // Verify env vars were added
            setTimeout(() => {
                const envContainer = document.getElementById('deploy-env');
                if (envContainer) {
                    const envItems = envContainer.querySelectorAll('.array-item');
                    console.log('[DEBUG] Env vars added to DOM:', envItems.length, 'Expected:', envArray.length);
                }
            }, 100);
        } catch (error) {
            console.error('[ERROR] Failed to populate environment variables from template:', error);
        }
    } else {
        console.log('[DEBUG] No env property found in template');
    }
    
    // Populate restart policy if present in template
    console.log('[DEBUG] Checking template.restart_policy:', template.restart_policy);
    if (template.restart_policy) {
        try {
            const restartPolicyEl = document.getElementById('deploy-restart-policy');
            if (restartPolicyEl) {
                restartPolicyEl.value = String(template.restart_policy);
                console.log('[DEBUG] Restart policy set to:', template.restart_policy);
            } else {
                console.warn('[WARN] Restart policy element not found');
            }
        } catch (error) {
            console.error('[ERROR] Failed to populate restart policy from template:', error);
        }
    } else {
        console.log('[DEBUG] No restart_policy property found in template');
    }

    // Show the modal first, then ensure ports are populated after it's shown
    if (templateDeployModal) {
        templateDeployModal.show();
        
        // Wait for modal to be fully shown before populating ports (fallback)
        // Bootstrap modal fires 'shown.bs.modal' event when fully displayed
        const modalElement = document.getElementById('templateDeployModalUnique');
        if (modalElement) {
            const populateAfterShow = () => {
                console.log('[DEBUG] ===== Modal shown event fired, re-checking ALL template properties =====');
                console.log('[DEBUG] Template in modal shown handler:', template);
                console.log('[DEBUG] Template.ports in modal shown handler:', template.ports);
                
                // Always try to populate ports again after modal is shown (ensures timing isn't an issue)
                if (template.ports) {
                    const portsContainer = document.getElementById('deploy-ports-container');
                    if (portsContainer) {
                        const existingPorts = portsContainer.querySelectorAll('.port-mapping-item');
                        const portsArray = Array.isArray(template.ports) ? template.ports : [template.ports];
                        
                        console.log('[DEBUG] Existing ports in DOM:', existingPorts.length, 'Expected:', portsArray.length);
                        
                        // If no ports found, populate them now
                        if (existingPorts.length === 0 && portsArray.length > 0) {
                            console.log('[DEBUG] No ports found in DOM, populating now after modal shown');
                            portsArray.forEach((port, index) => {
                                if (port != null && port !== undefined) {
                                    let portValue;
                                    if (typeof port === 'string') {
                                        portValue = port.trim();
                                    } else if (typeof port === 'number') {
                                        portValue = String(port);
                                    } else if (typeof port === 'object' && (port.container || port.target)) {
                                        const containerPort = port.container || port.target;
                                        const protocol = port.protocol || 'tcp';
                                        const hostPort = port.host || port.published || '';
                                        portValue = hostPort ? `${hostPort}:${containerPort}/${protocol}` : `${containerPort}/${protocol}`;
                                    } else {
                                        portValue = String(port);
                                    }
                                    
                                    if (portValue && portValue.trim()) {
                                        console.log(`[DEBUG] Adding port ${index} after modal shown:`, portValue);
                                        addPortMapping(portValue);
                                    }
                                }
                            });
                        } else if (existingPorts.length > 0) {
                            console.log('[DEBUG] Ports already populated, skipping');
                        }
                    } else {
                        console.error('[ERROR] Ports container not found in modal shown handler');
                    }
                } else {
                    console.log('[DEBUG] No ports property in template');
                }
            };
            
            modalElement.addEventListener('shown.bs.modal', populateAfterShow, { once: true });
        }
    }
    
    updatePreview();
}

// Store current template for validation
let currentTemplate = null;

// Validate form data
function validateFormData(data) {
    const errors = [];
    
    // Container name validation
    if (!data.containerName || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(data.containerName)) {
        errors.push('Container name must be alphanumeric and may include dashes, underscores, or dots. Must start and end with alphanumeric.');
    }
    
    if (data.containerName && data.containerName.length > 63) {
        errors.push('Container name must be 63 characters or less.');
    }
    
    // Image validation
    if (!data.image || !data.image.trim()) {
        errors.push('Image name is required.');
    } else {
        // Basic image name validation
        const imagePattern = /^([a-z0-9._-]+\/)*[a-z0-9._-]+(:[a-zA-Z0-9._-]+)?$/;
        if (!imagePattern.test(data.image.trim())) {
            errors.push('Invalid Docker image name format.');
        }
    }
    
    // Validate ports
    if (data.ports && Array.isArray(data.ports)) {
        data.ports.forEach((port, idx) => {
            const portStr = String(port).trim();
            // Support both "host:container/protocol" and "container/protocol" formats
            const portPattern1 = /^(\d+):(\d+)\/(tcp|udp)$/; // host:container/protocol
            const portPattern2 = /^(\d+)\/(tcp|udp)$/; // container/protocol
            
            if (!portPattern1.test(portStr) && !portPattern2.test(portStr)) {
                errors.push(`Port ${idx + 1} has invalid format. Use "host:container/protocol" or "container/protocol".`);
            } else {
                // Validate port numbers are in valid range
                const match = portStr.match(portPattern1) || portStr.match(portPattern2);
                if (match) {
                    const hostPort = match[1] ? parseInt(match[1], 10) : null;
                    const containerPort = parseInt(match[2] || match[1], 10);
                    
                    if (hostPort && (hostPort < 1 || hostPort > 65535)) {
                        errors.push(`Port ${idx + 1}: Host port must be between 1 and 65535.`);
                    }
                    if (containerPort < 1 || containerPort > 65535) {
                        errors.push(`Port ${idx + 1}: Container port must be between 1 and 65535.`);
                    }
                }
            }
        });
    }
    
    // Validate volumes
    if (data.volumes && Array.isArray(data.volumes)) {
        data.volumes.forEach((volume, idx) => {
            const volumeStr = String(volume).trim();
            if (!volumeStr.includes(':')) {
                errors.push(`Volume ${idx + 1} must contain a colon (host:container or host:container:mode).`);
            } else {
                const parts = volumeStr.split(':');
                if (parts.length < 2 || parts.length > 3) {
                    errors.push(`Volume ${idx + 1} has invalid format. Use "host:container" or "host:container:mode".`);
                }
                // Check for path traversal attempts
                if (parts.some(part => part.includes('..'))) {
                    errors.push(`Volume ${idx + 1} contains invalid path (path traversal not allowed).`);
                }
            }
        });
    }
    
    // Validate environment variables
    if (data.env && Array.isArray(data.env)) {
        const envContainer = document.getElementById('deploy-env');
        if (envContainer && currentTemplate && currentTemplate.env) {
            // Create a map of template env vars for validation
            const templateEnvMap = {};
            currentTemplate.env.forEach(env => {
                templateEnvMap[env.name] = env;
            });
            
            data.env.forEach(envVar => {
                const templateEnv = templateEnvMap[envVar.name];
                if (templateEnv) {
                    // Validate select options
                    if (templateEnv.select && Array.isArray(templateEnv.select)) {
                        const validOptions = templateEnv.select.map(opt => 
                            typeof opt === 'object' ? opt.value : opt
                        );
                        if (!validOptions.includes(envVar.value)) {
                            errors.push(`Environment variable "${templateEnv.label || envVar.name}": Value must be one of: ${validOptions.join(', ')}`);
                        }
                    }
                    
                    // Validate numeric ranges
                    if (templateEnv.min !== undefined || templateEnv.max !== undefined) {
                        const numValue = parseFloat(envVar.value);
                        if (isNaN(numValue)) {
                            errors.push(`Environment variable "${templateEnv.label || envVar.name}": Must be a number.`);
                        } else {
                            if (templateEnv.min !== undefined && numValue < templateEnv.min) {
                                errors.push(`Environment variable "${templateEnv.label || envVar.name}": Must be at least ${templateEnv.min}.`);
                            }
                            if (templateEnv.max !== undefined && numValue > templateEnv.max) {
                                errors.push(`Environment variable "${templateEnv.label || envVar.name}": Must be at most ${templateEnv.max}.`);
                            }
                        }
                    }
                    
                    // Check required fields
                    if ((templateEnv.required === true || (templateEnv.default === undefined && templateEnv.set === undefined)) && !envVar.value) {
                        errors.push(`Environment variable "${templateEnv.label || envVar.name}" is required.`);
                    }
                }
            });
        }
        
        // Validate env var names
        data.env.forEach(envVar => {
            if (envVar.name && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(envVar.name)) {
                errors.push(`Environment variable name "${envVar.name}" is invalid. Must start with letter or underscore and contain only alphanumeric characters and underscores.`);
            }
        });
    }
    
    // Validate resource limits
    if (data.cpuLimit !== undefined && data.cpuLimit !== null) {
        if (isNaN(data.cpuLimit) || data.cpuLimit <= 0) {
            errors.push('CPU limit must be a positive number.');
        }
    }
    
    if (data.memoryLimit !== undefined && data.memoryLimit !== null) {
        if (isNaN(data.memoryLimit) || data.memoryLimit <= 0) {
            errors.push('Memory limit must be a positive number (in MB).');
        }
    }
    
    if (data.memoryReservation !== undefined && data.memoryReservation !== null) {
        if (isNaN(data.memoryReservation) || data.memoryReservation <= 0) {
            errors.push('Memory reservation must be a positive number (in MB).');
        }
        if (data.memoryLimit && data.memoryReservation > data.memoryLimit) {
            errors.push('Memory reservation cannot exceed memory limit.');
        }
    }
    
    if (data.cpuReservation !== undefined && data.cpuReservation !== null) {
        if (isNaN(data.cpuReservation) || data.cpuReservation <= 0) {
            errors.push('CPU reservation must be a positive number.');
        }
        if (data.cpuLimit && data.cpuReservation > data.cpuLimit) {
            errors.push('CPU reservation cannot exceed CPU limit.');
        }
    }
    
    // Validate hostname
    if (data.hostname) {
        const hostnamePattern = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
        if (data.hostname.length > 253 || !hostnamePattern.test(data.hostname)) {
            errors.push('Invalid hostname format.');
        }
    }
    
    // Validate domainname
    if (data.domainname) {
        const domainnamePattern = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
        if (data.domainname.length > 253 || !domainnamePattern.test(data.domainname)) {
            errors.push('Invalid domain name format.');
        }
    }
    
    // Validate DNS servers
    if (data.dns && Array.isArray(data.dns)) {
        data.dns.forEach((dns, idx) => {
            const dnsStr = String(dns).trim();
            // IPv4 pattern
            const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
            // IPv6 pattern (simplified)
            const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
            
            if (!ipv4Pattern.test(dnsStr) && !ipv6Pattern.test(dnsStr)) {
                errors.push(`DNS server ${idx + 1} has invalid IP address format.`);
            } else if (ipv4Pattern.test(dnsStr)) {
                const parts = dnsStr.split('.');
                if (parts.some(part => {
                    const num = parseInt(part, 10);
                    return num < 0 || num > 255;
                })) {
                    errors.push(`DNS server ${idx + 1} has invalid IPv4 address.`);
                }
            }
        });
    }
    
    // Validate restart policy
    const validRestartPolicies = ['no', 'always', 'on-failure', 'unless-stopped'];
    if (data.restartPolicy && !validRestartPolicies.includes(data.restartPolicy)) {
        errors.push(`Invalid restart policy. Must be one of: ${validRestartPolicies.join(', ')}`);
    }
    
    return errors;
}

// Deploy Docker container
async function deployDockerContainer(payload) {
    console.log('[INFO] Sending deployment command to the server...');

    return new Promise((resolve, reject) => {
        // Store the original handler to restore it later
        const originalHandler = window.handlePeerResponse;
        let timeoutId = null;
        let isResolved = false;

        // Create a deployment-specific handler
        const deploymentHandler = (response) => {
            // Only process responses related to deployment
            if (isResolved) {
                // If already resolved, pass to original handler if it exists
                if (typeof originalHandler === 'function') {
                    originalHandler(response);
                }
                return;
            }

            // Check if this is a deployment response
            const isDeploymentResponse = 
                (response.success && response.message && typeof response.message === 'string' && response.message.includes('deployed successfully')) ||
                (response.error && (
                    (response.message && typeof response.message === 'string' && response.message.includes('deploy')) ||
                    (typeof response.error === 'string' && (response.error.includes('deploy') || response.error.includes('Container')))
                ));

            if (isDeploymentResponse) {
                // Clear timeout
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }

                // Restore original handler
                window.handlePeerResponse = originalHandler;
                isResolved = true;

                if (response.success && response.message && response.message.includes('deployed successfully')) {
                    console.log('[INFO] Deployment response received:', response.message);
                    resolve(response);
                } else if (response.error) {
                    // Safely extract error message
                    const errorMessage = typeof response.error === 'string' 
                        ? response.error 
                        : (response.error?.message || response.error?.toString() || 'Unknown deployment error');
                    reject(new Error(errorMessage));
                } else {
                    // Unexpected response format
                    reject(new Error('Unexpected response format from server'));
                }
            } else {
                // Not a deployment response, pass to original handler if it exists
                if (typeof originalHandler === 'function') {
                    originalHandler(response);
                }
            }
        };

        // Set the deployment handler
        window.handlePeerResponse = deploymentHandler;

        // Use window.sendCommand to avoid TDZ issues
        if (typeof window.sendCommand === 'function') {
            window.sendCommand('deployContainer', payload);
        } else {
            // Restore original handler before rejecting
            window.handlePeerResponse = originalHandler;
            reject(new Error('sendCommand is not available. Please ensure app.js is loaded.'));
            return;
        }

        // Set timeout with cleanup
        timeoutId = setTimeout(() => {
            if (!isResolved) {
                // Restore original handler
                window.handlePeerResponse = originalHandler;
                isResolved = true;
                reject(new Error('Deployment timed out. No response from server.'));
            }
        }, 60000); // Increased timeout for complex deployments
    });
}

// Form submission is now handled by setupFormSubmitListener() which is called during lazy initialization

// Save template functionality removed to match working version

// Templates are now loaded lazily when the modal is opened (via fetchTemplates() in openTemplateDeployModal)
// This prevents icons and template data from loading on app startup

// Duplicate modal array management functions
let duplicatePortCounter = 0;
let duplicateVolumeCounter = 0;
let duplicateEnvCounter = 0;
let duplicateLabelCounter = 0;
let duplicateDnsCounter = 0;
let duplicateExtraHostCounter = 0;
let duplicateDeviceCounter = 0;
let duplicateCapabilityCounter = 0;
let duplicateSecurityOptCounter = 0;
let duplicateLogOptCounter = 0;
let duplicateSysctlCounter = 0;
let duplicateUlimitCounter = 0;
let duplicateTmpfsCounter = 0;

function addDuplicatePortMapping(portData = null) {
    const container = document.getElementById('duplicate-ports-container');
    if (!container) return;
    const id = `duplicate-port-${duplicatePortCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item port-mapping-item';
    item.id = id;
    
    // Parse existing port data if provided
    let hostPort = '';
    let containerPort = '';
    let protocol = 'tcp';
    
    if (portData) {
        if (portData.includes(':')) {
            const [host, rest] = portData.split(':');
            hostPort = host;
            const [container, proto] = rest.split('/');
            containerPort = container;
            protocol = proto || 'tcp';
        } else {
            const [container, proto] = portData.split('/');
            containerPort = container;
            protocol = proto || 'tcp';
        }
    }
    
    item.innerHTML = `
        <div class="port-mapping-fields">
            <div class="port-field-group">
                <label class="port-field-label">Host Port</label>
                <input type="number" 
                       class="form-control bg-dark text-white port-host-input" 
                       placeholder="8080" 
                       min="1" 
                       max="65535"
                       data-port-host="${id}"
                       value="${hostPort}"
                       oninput="validatePortMapping('${id}')">
                <small class="port-error-msg" data-port-host-error="${id}" style="display: none;"></small>
            </div>
            <div class="port-connector">
                <i class="fas fa-arrow-right"></i>
            </div>
            <div class="port-field-group">
                <label class="port-field-label">Container Port</label>
                <input type="number" 
                       class="form-control bg-dark text-white port-container-input" 
                       placeholder="80" 
                       min="1" 
                       max="65535"
                       required
                       data-port-container="${id}"
                       value="${containerPort}"
                       oninput="validatePortMapping('${id}')">
                <small class="port-error-msg" data-port-container-error="${id}" style="display: none;"></small>
            </div>
            <div class="port-field-group">
                <label class="port-field-label">Protocol</label>
                <select class="form-select bg-dark text-white port-protocol-input" 
                        data-port-protocol="${id}"
                        onchange="validatePortMapping('${id}')">
                    <option value="tcp" ${protocol === 'tcp' ? 'selected' : ''}>TCP</option>
                    <option value="udp" ${protocol === 'udp' ? 'selected' : ''}>UDP</option>
                </select>
            </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateVolumeMount(volumeData = null) {
    const container = document.getElementById('duplicate-volumes-container');
    if (!container) return;
    const id = `duplicate-volume-${duplicateVolumeCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item volume-mount-item';
    item.id = id;
    
    // Parse existing volume data if provided
    let volumeType = 'bind';
    let hostPath = '';
    let containerPath = '';
    let mountMode = 'rw';
    
    if (volumeData) {
        const parts = volumeData.split(':');
        if (parts.length >= 2) {
            // Check if it's a named volume (starts with volume name, no leading slash)
            if (!parts[0].startsWith('/') && !parts[0].startsWith('~')) {
                volumeType = 'named';
                hostPath = parts[0];
            } else {
                volumeType = 'bind';
                hostPath = parts[0];
            }
            containerPath = parts[1];
            if (parts.length === 3) {
                mountMode = parts[2];
            }
        }
    }
    
    item.innerHTML = `
        <div class="volume-mount-fields">
            <div class="volume-field-group">
                <label class="volume-field-label">Type</label>
                <select class="form-select bg-dark text-white volume-type-input" 
                        data-volume-type="${id}"
                        onchange="handleVolumeTypeChange('${id}')">
                    <option value="bind" ${volumeType === 'bind' ? 'selected' : ''}>Bind Mount</option>
                    <option value="named" ${volumeType === 'named' ? 'selected' : ''}>Named Volume</option>
                </select>
            </div>
            <div class="volume-field-group volume-host-path-group" style="${volumeType === 'named' ? 'display: none;' : ''}">
                <label class="volume-field-label">Host Path</label>
                <div class="input-group">
                    <input type="text" 
                           class="form-control bg-dark text-white volume-host-input" 
                           placeholder="/host/path" 
                           data-volume-host="${id}"
                           value="${hostPath}"
                           oninput="validateVolumeMount('${id}')">
                    <button type="button" 
                            class="btn btn-outline-secondary" 
                            onclick="openFileBrowser('${id}')"
                            title="Browse directory">
                        <i class="fas fa-folder-open"></i>
                    </button>
                </div>
                <small class="volume-error-msg" data-volume-host-error="${id}" style="display: none;"></small>
            </div>
            <div class="volume-field-group volume-named-group" style="${volumeType === 'bind' ? 'display: none;' : ''}">
                <label class="volume-field-label">Volume Name</label>
                <select class="form-select bg-dark text-white volume-named-input" 
                        data-volume-named="${id}"
                        onchange="validateVolumeMount('${id}')"
                        onfocus="if(this.options.length <= 1) loadVolumesForSelect('${id}')"
                        onclick="if(this.options.length <= 1) loadVolumesForSelect('${id}')">
                    <option value="">Select or create volume...</option>
                </select>
                <small class="volume-error-msg" data-volume-named-error="${id}" style="display: none;"></small>
            </div>
            <div class="volume-connector">
                <i class="fas fa-arrow-right"></i>
            </div>
            <div class="volume-field-group">
                <label class="volume-field-label">Container Path</label>
                <input type="text" 
                       class="form-control bg-dark text-white volume-container-input" 
                       placeholder="/container/path" 
                       required
                       data-volume-container="${id}"
                       value="${containerPath}"
                       oninput="validateVolumeMount('${id}')">
                <small class="volume-error-msg" data-volume-container-error="${id}" style="display: none;"></small>
            </div>
            <div class="volume-field-group">
                <label class="volume-field-label">Mode</label>
                <select class="form-select bg-dark text-white volume-mode-input" 
                        data-volume-mode="${id}"
                        onchange="validateVolumeMount('${id}')">
                    <option value="rw" ${mountMode === 'rw' ? 'selected' : ''}>Read-Write</option>
                    <option value="ro" ${mountMode === 'ro' ? 'selected' : ''}>Read-Only</option>
                </select>
            </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
    
    // Load volumes if named volume is selected
    if (volumeType === 'named') {
        loadVolumesForSelect(id);
    }
}

function addDuplicateTmpfsMount() {
    const container = document.getElementById('duplicate-tmpfs-container');
    if (!container) return;
    const id = `duplicate-tmpfs-${duplicateTmpfsCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="/tmp:100m" data-tmpfs-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateEnvVar() {
    const container = document.getElementById('duplicate-env');
    if (!container) return;
    const id = `duplicate-env-${duplicateEnvCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item mb-2';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="KEY" data-env-key="${id}" style="flex: 0 0 40%;">
        <input type="text" class="form-control bg-dark text-white" placeholder="value" data-env-value="${id}" style="flex: 1;">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateLabel() {
    const container = document.getElementById('duplicate-labels-container');
    if (!container) return;
    const id = `duplicate-label-${duplicateLabelCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="key=value" data-label-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateDnsServer() {
    const container = document.getElementById('duplicate-dns-container');
    if (!container) return;
    const id = `duplicate-dns-${duplicateDnsCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="8.8.8.8" data-dns-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateExtraHost() {
    const container = document.getElementById('duplicate-extra-hosts-container');
    if (!container) return;
    const id = `duplicate-host-${duplicateExtraHostCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="example.com:127.0.0.1" data-host-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateDeviceMapping() {
    const container = document.getElementById('duplicate-devices-container');
    if (!container) return;
    const id = `duplicate-device-${duplicateDeviceCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="/dev/ttyUSB0:/dev/ttyUSB0:rwm" data-device-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateCapability() {
    const container = document.getElementById('duplicate-capabilities-container');
    if (!container) return;
    const id = `duplicate-cap-${duplicateCapabilityCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="NET_ADMIN" data-cap-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateSecurityOpt() {
    const container = document.getElementById('duplicate-security-opts-container');
    if (!container) return;
    const id = `duplicate-secopt-${duplicateSecurityOptCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="apparmor=profile" data-secopt-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateLogOpt() {
    const container = document.getElementById('duplicate-log-opts-container');
    if (!container) return;
    const id = `duplicate-logopt-${duplicateLogOptCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="max-size=10m" data-logopt-key="${id}" style="flex: 0 0 40%;">
        <input type="text" class="form-control bg-dark text-white" placeholder="value" data-logopt-value="${id}" style="flex: 1;">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateSysctl() {
    const container = document.getElementById('duplicate-sysctls-container');
    if (!container) return;
    const id = `duplicate-sysctl-${duplicateSysctlCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="net.ipv4.ip_forward=1" data-sysctl-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

function addDuplicateUlimit() {
    const container = document.getElementById('duplicate-ulimits-container');
    if (!container) return;
    const id = `duplicate-ulimit-${duplicateUlimitCounter++}`;
    const item = document.createElement('div');
    item.className = 'array-item';
    item.id = id;
    item.innerHTML = `
        <input type="text" class="form-control bg-dark text-white" placeholder="nofile=1024:2048" data-ulimit-id="${id}">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeArrayItem('${id}')">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(item);
}

// Make duplicate functions globally available
window.addDuplicatePortMapping = addDuplicatePortMapping;
window.addDuplicateVolumeMount = addDuplicateVolumeMount;
window.addDuplicateTmpfsMount = addDuplicateTmpfsMount;
window.addDuplicateEnvVar = addDuplicateEnvVar;
window.addDuplicateLabel = addDuplicateLabel;
window.addDuplicateDnsServer = addDuplicateDnsServer;
window.addDuplicateExtraHost = addDuplicateExtraHost;
window.addDuplicateDeviceMapping = addDuplicateDeviceMapping;
window.addDuplicateCapability = addDuplicateCapability;
window.addDuplicateSecurityOpt = addDuplicateSecurityOpt;
window.addDuplicateLogOpt = addDuplicateLogOpt;
window.addDuplicateSysctl = addDuplicateSysctl;
window.addDuplicateUlimit = addDuplicateUlimit;

// Collect duplicate form data (similar to collectFormData but for duplicate modal)
function collectDuplicateFormData() {
    const data = {
        containerName: document.getElementById('duplicate-container-name')?.value.trim() || '',
        image: document.getElementById('duplicate-image')?.value.trim() || '',
        command: document.getElementById('duplicate-command')?.value.trim() || null,
        entrypoint: document.getElementById('duplicate-entrypoint')?.value.trim() || null,
        workingDir: document.getElementById('duplicate-workdir')?.value.trim() || null,
        
        // Networking
        networkMode: document.getElementById('duplicate-network-mode')?.value || 'bridge',
        customNetwork: (() => {
            const mode = document.getElementById('duplicate-network-mode')?.value;
            const customNet = document.getElementById('duplicate-custom-network')?.value.trim();
            if ((mode === 'container' || (mode && mode !== 'bridge' && mode !== 'host' && mode !== 'none')) && customNet) {
                return customNet;
            }
            return null;
        })(),
        hostname: document.getElementById('duplicate-hostname')?.value.trim() || null,
        domainname: document.getElementById('duplicate-domainname')?.value.trim() || null,
        ports: collectDuplicatePortMappings(),
        dns: collectArrayItems('duplicate-dns-container', 'data-dns-id'),
        extraHosts: collectArrayItems('duplicate-extra-hosts-container', 'data-host-id'),
        
        // Volumes
        volumes: collectDuplicateVolumeMounts(),
        tmpfs: collectArrayItems('duplicate-tmpfs-container', 'data-tmpfs-id'),
        
        // Resources
        cpuLimit: parseFloat(document.getElementById('duplicate-cpu-limit')?.value) || null,
        cpuReservation: parseFloat(document.getElementById('duplicate-cpu-reservation')?.value) || null,
        cpuShares: parseInt(document.getElementById('duplicate-cpu-shares')?.value) || null,
        memoryLimit: parseInt(document.getElementById('duplicate-memory-limit')?.value) || null,
        memoryReservation: parseInt(document.getElementById('duplicate-memory-reservation')?.value) || null,
        memorySwap: parseInt(document.getElementById('duplicate-memory-swap')?.value) || null,
        devices: collectArrayItems('duplicate-devices-container', 'data-device-id'),
        
        // Environment & Labels
        env: collectDuplicateEnvVars(),
        labels: collectDuplicateLabels(),
        
        // Security
        user: document.getElementById('duplicate-user')?.value.trim() || null,
        group: document.getElementById('duplicate-group')?.value.trim() || null,
        privileged: document.getElementById('duplicate-privileged')?.checked || false,
        readonlyRootfs: document.getElementById('duplicate-readonly-rootfs')?.checked || false,
        capabilities: collectArrayItems('duplicate-capabilities-container', 'data-cap-id'),
        securityOpts: collectArrayItems('duplicate-security-opts-container', 'data-secopt-id'),
        
        // Runtime
        restartPolicy: document.getElementById('duplicate-restart-policy')?.value || 'no',
        restartMaxRetries: parseInt(document.getElementById('duplicate-restart-max-retries')?.value) || null,
        autoRemove: document.getElementById('duplicate-auto-remove')?.checked || false,
        tty: document.getElementById('duplicate-tty')?.checked || false,
        stdinOpen: document.getElementById('duplicate-stdin-open')?.checked || false,
        detach: document.getElementById('duplicate-detach')?.checked !== false,
        init: document.getElementById('duplicate-init')?.checked || false,
        
        // Health & Logging
        healthCmd: document.getElementById('duplicate-health-cmd')?.value.trim() || null,
        healthInterval: parseInt(document.getElementById('duplicate-health-interval')?.value) || null,
        healthTimeout: parseInt(document.getElementById('duplicate-health-timeout')?.value) || null,
        healthRetries: parseInt(document.getElementById('duplicate-health-retries')?.value) || null,
        healthStartPeriod: parseInt(document.getElementById('duplicate-health-start-period')?.value) || null,
        logDriver: document.getElementById('duplicate-log-driver')?.value || null,
        logOpts: collectDuplicateLogOpts(),
        
        // Advanced
        sysctls: collectDuplicateSysctls(),
        ulimits: collectDuplicateUlimits(),
        oomKillDisable: document.getElementById('duplicate-oom-kill-disable')?.checked || false,
        pidsLimit: parseInt(document.getElementById('duplicate-pids-limit')?.value) || null,
        shmSize: parseInt(document.getElementById('duplicate-shm-size')?.value) || null,
    };
    
    // Remove null/empty values
    Object.keys(data).forEach(key => {
        if (data[key] === null || data[key] === '' || (Array.isArray(data[key]) && data[key].length === 0)) {
            delete data[key];
        }
    });
    
    return data;
}

function collectDuplicateEnvVars() {
    const container = document.getElementById('duplicate-env');
    if (!container) return [];
    const envVars = [];
    container.querySelectorAll('[data-env-key]').forEach(keyInput => {
        const key = keyInput.value.trim();
        const valueInput = container.querySelector(`[data-env-value="${keyInput.getAttribute('data-env-key')}"]`);
        const value = valueInput?.value.trim() || '';
        if (key) {
            envVars.push({ name: key, value });
        }
    });
    return envVars;
}

function collectDuplicateLabels() {
    const items = collectArrayItems('duplicate-labels-container', 'data-label-id');
    const labels = {};
    items.forEach(item => {
        const [key, value] = item.split('=');
        if (key && value) {
            labels[key.trim()] = value.trim();
        }
    });
    return Object.keys(labels).length > 0 ? labels : null;
}

function collectDuplicateLogOpts() {
    const container = document.getElementById('duplicate-log-opts-container');
    if (!container) return null;
    const opts = {};
    container.querySelectorAll('[data-logopt-key]').forEach(keyInput => {
        const key = keyInput.value.trim();
        const valueInput = container.querySelector(`[data-logopt-value="${keyInput.getAttribute('data-logopt-key')}"]`);
        const value = valueInput?.value.trim() || '';
        if (key) {
            opts[key] = value;
        }
    });
    return Object.keys(opts).length > 0 ? opts : null;
}

function collectDuplicateSysctls() {
    const items = collectArrayItems('duplicate-sysctls-container', 'data-sysctl-id');
    const sysctls = {};
    items.forEach(item => {
        const [key, value] = item.split('=');
        if (key && value) {
            sysctls[key.trim()] = value.trim();
        }
    });
    return Object.keys(sysctls).length > 0 ? sysctls : null;
}

function collectDuplicateUlimits() {
    const items = collectArrayItems('duplicate-ulimits-container', 'data-ulimit-id');
    const ulimits = [];
    items.forEach(item => {
        const [name, limits] = item.split('=');
        if (name && limits) {
            const [soft, hard] = limits.split(':');
            ulimits.push({
                Name: name.trim(),
                Soft: soft ? parseInt(soft) : null,
                Hard: hard ? parseInt(hard) : null
            });
        }
    });
    return ulimits.length > 0 ? ulimits : null;
}

// Collect duplicate port mappings from structured inputs
function collectDuplicatePortMappings() {
    const container = document.getElementById('duplicate-ports-container');
    if (!container) return [];
    const ports = [];
    
    container.querySelectorAll('.port-mapping-item').forEach(item => {
        const hostInput = item.querySelector('.port-host-input');
        const containerInput = item.querySelector('.port-container-input');
        const protocolInput = item.querySelector('.port-protocol-input');
        
        if (!containerInput || !containerInput.value) return;
        
        const hostPort = hostInput?.value.trim() || '';
        const containerPort = containerInput.value.trim();
        const protocol = protocolInput?.value || 'tcp';
        
        // Build port string: host:container/protocol or container/protocol
        const portStr = hostPort ? `${hostPort}:${containerPort}/${protocol}` : `${containerPort}/${protocol}`;
        ports.push(portStr);
    });
    
    return ports;
}

// Collect duplicate volume mounts from structured inputs
function collectDuplicateVolumeMounts() {
    const container = document.getElementById('duplicate-volumes-container');
    if (!container) return [];
    const volumes = [];
    
    container.querySelectorAll('.volume-mount-item').forEach(item => {
        const typeSelect = item.querySelector('.volume-type-input');
        const hostInput = item.querySelector('.volume-host-input');
        const namedSelect = item.querySelector('.volume-named-input');
        const containerInput = item.querySelector('.volume-container-input');
        const modeSelect = item.querySelector('.volume-mode-input');
        
        if (!containerInput || !containerInput.value) return;
        
        const volumeType = typeSelect?.value || 'bind';
        const containerPath = containerInput.value.trim();
        const mountMode = modeSelect?.value || 'rw';
        
        let volumeStr = '';
        
        if (volumeType === 'bind') {
            const hostPath = hostInput?.value.trim() || '';
            if (!hostPath) return; // Skip if host path is empty
            volumeStr = `${hostPath}:${containerPath}:${mountMode}`;
        } else {
            // Named volume
            const volumeName = namedSelect?.value.trim() || '';
            if (!volumeName) return; // Skip if volume name is empty
            volumeStr = `${volumeName}:${containerPath}:${mountMode}`;
        }
        
        volumes.push(volumeStr);
    });
    
    return volumes;
}

// Populate duplicate form from container config
function populateDuplicateForm(config) {
    if (!config) return;
    
    // Reset counters
    duplicatePortCounter = duplicateVolumeCounter = duplicateEnvCounter = duplicateLabelCounter = duplicateDnsCounter = 0;
    duplicateExtraHostCounter = duplicateDeviceCounter = duplicateCapabilityCounter = duplicateSecurityOptCounter = 0;
    duplicateLogOptCounter = duplicateSysctlCounter = duplicateUlimitCounter = duplicateTmpfsCounter = 0;
    
    // Clear all array containers
    ['duplicate-ports-container', 'duplicate-volumes-container', 'duplicate-env', 'duplicate-labels-container',
     'duplicate-dns-container', 'duplicate-extra-hosts-container', 'duplicate-devices-container',
     'duplicate-capabilities-container', 'duplicate-security-opts-container', 'duplicate-log-opts-container',
     'duplicate-sysctls-container', 'duplicate-ulimits-container', 'duplicate-tmpfs-container'].forEach(id => {
        const container = document.getElementById(id);
        if (container) container.innerHTML = '';
    });
    
    // Basic settings
    const nameEl = document.getElementById('duplicate-container-name');
    if (nameEl) nameEl.value = config.Name ? config.Name.replace(/^\//, '') : '';
    
    const imageEl = document.getElementById('duplicate-image');
    if (imageEl) imageEl.value = config.Config?.Image || '';
    
    const commandEl = document.getElementById('duplicate-command');
    if (commandEl && config.Config?.Cmd) {
        commandEl.value = Array.isArray(config.Config.Cmd) ? config.Config.Cmd.join(' ') : config.Config.Cmd;
    }
    
    const entrypointEl = document.getElementById('duplicate-entrypoint');
    if (entrypointEl && config.Config?.Entrypoint) {
        entrypointEl.value = Array.isArray(config.Config.Entrypoint) ? config.Config.Entrypoint.join(' ') : config.Config.Entrypoint;
    }
    
    const workdirEl = document.getElementById('duplicate-workdir');
    if (workdirEl) workdirEl.value = config.Config?.WorkingDir || '';
    
    // Networking
    const networkModeEl = document.getElementById('duplicate-network-mode');
    if (networkModeEl && config.HostConfig?.NetworkMode) {
        const netMode = config.HostConfig.NetworkMode;
        if (netMode.startsWith('container:')) {
            networkModeEl.value = 'container';
            const customNetEl = document.getElementById('duplicate-custom-network');
            if (customNetEl) {
                customNetEl.value = netMode.replace('container:', '');
                document.getElementById('duplicate-custom-network-container').style.display = 'block';
            }
        } else {
            networkModeEl.value = netMode;
        }
    }
    
    const hostnameEl = document.getElementById('duplicate-hostname');
    if (hostnameEl) hostnameEl.value = config.Config?.Hostname || '';
    
    const domainnameEl = document.getElementById('duplicate-domainname');
    if (domainnameEl) domainnameEl.value = config.Config?.Domainname || '';
    
    // Port bindings
    if (config.HostConfig?.PortBindings) {
        Object.entries(config.HostConfig.PortBindings).forEach(([containerPort, bindings]) => {
            if (bindings && bindings.length > 0) {
                const binding = bindings[0];
                const protocol = containerPort.split('/')[1] || 'tcp';
                const portNum = containerPort.split('/')[0];
                const portStr = binding.HostPort ? `${binding.HostPort}:${portNum}/${protocol}` : `${portNum}/${protocol}`;
                addDuplicatePortMapping(portStr);
            }
        });
    }
    
    // DNS
    if (config.HostConfig?.Dns && Array.isArray(config.HostConfig.Dns)) {
        config.HostConfig.Dns.forEach(dns => {
            addDuplicateDnsServer();
            const container = document.getElementById('duplicate-dns-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = dns;
        });
    }
    
    // Extra hosts
    if (config.HostConfig?.ExtraHosts && Array.isArray(config.HostConfig.ExtraHosts)) {
        config.HostConfig.ExtraHosts.forEach(host => {
            addDuplicateExtraHost();
            const container = document.getElementById('duplicate-extra-hosts-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = host;
        });
    }
    
    // Volumes
    if (config.HostConfig?.Binds && Array.isArray(config.HostConfig.Binds)) {
        config.HostConfig.Binds.forEach(bind => {
            addDuplicateVolumeMount(bind);
        });
    }
    
    // Tmpfs
    if (config.HostConfig?.Tmpfs && typeof config.HostConfig.Tmpfs === 'object') {
        Object.entries(config.HostConfig.Tmpfs).forEach(([path, opts]) => {
            addDuplicateTmpfsMount();
            const container = document.getElementById('duplicate-tmpfs-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = opts ? `${path}:${opts}` : path;
        });
    }
    
    // Resources
    if (config.HostConfig?.NanoCpus) {
        const cpuLimitEl = document.getElementById('duplicate-cpu-limit');
        if (cpuLimitEl) cpuLimitEl.value = config.HostConfig.NanoCpus / 1000000000;
    }
    if (config.HostConfig?.CpuQuota) {
        const cpuReservationEl = document.getElementById('duplicate-cpu-reservation');
        if (cpuReservationEl) cpuReservationEl.value = config.HostConfig.CpuQuota / 1000000000;
    }
    if (config.HostConfig?.CpuShares) {
        const cpuSharesEl = document.getElementById('duplicate-cpu-shares');
        if (cpuSharesEl) cpuSharesEl.value = config.HostConfig.CpuShares;
    }
    if (config.HostConfig?.Memory) {
        const memoryLimitEl = document.getElementById('duplicate-memory-limit');
        if (memoryLimitEl) memoryLimitEl.value = Math.round(config.HostConfig.Memory / (1024 * 1024));
    }
    if (config.HostConfig?.MemoryReservation) {
        const memoryReservationEl = document.getElementById('duplicate-memory-reservation');
        if (memoryReservationEl) memoryReservationEl.value = Math.round(config.HostConfig.MemoryReservation / (1024 * 1024));
    }
    if (config.HostConfig?.MemorySwap !== undefined) {
        const memorySwapEl = document.getElementById('duplicate-memory-swap');
        if (memorySwapEl) memorySwapEl.value = config.HostConfig.MemorySwap === -1 ? -1 : Math.round(config.HostConfig.MemorySwap / (1024 * 1024));
    }
    
    // Devices
    if (config.HostConfig?.Devices && Array.isArray(config.HostConfig.Devices)) {
        config.HostConfig.Devices.forEach(device => {
            const deviceStr = `${device.PathOnHost}:${device.PathInContainer}:${device.CgroupPermissions || 'rwm'}`;
            addDuplicateDeviceMapping();
            const container = document.getElementById('duplicate-devices-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = deviceStr;
        });
    }
    
    // Environment variables
    if (config.Config?.Env && Array.isArray(config.Config.Env)) {
        config.Config.Env.forEach(envStr => {
            const [name, ...valueParts] = envStr.split('=');
            const value = valueParts.join('=');
            addDuplicateEnvVar();
            const container = document.getElementById('duplicate-env');
            const items = container.querySelectorAll('.array-item');
            const lastItem = items[items.length - 1];
            if (lastItem) {
                const keyInput = lastItem.querySelector('[data-env-key]');
                const valueInput = lastItem.querySelector('[data-env-value]');
                if (keyInput) keyInput.value = name || '';
                if (valueInput) valueInput.value = value || '';
            }
        });
    }
    
    // Labels
    if (config.Config?.Labels && typeof config.Config.Labels === 'object') {
        Object.entries(config.Config.Labels).forEach(([key, value]) => {
            addDuplicateLabel();
            const container = document.getElementById('duplicate-labels-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = `${key}=${value}`;
        });
    }
    
    // Security
    const userEl = document.getElementById('duplicate-user');
    if (userEl) userEl.value = config.Config?.User || '';
    
    const groupEl = document.getElementById('duplicate-group');
    if (groupEl && config.HostConfig?.GroupAdd && config.HostConfig.GroupAdd.length > 0) {
        groupEl.value = config.HostConfig.GroupAdd[0];
    }
    
    const privilegedEl = document.getElementById('duplicate-privileged');
    if (privilegedEl) privilegedEl.checked = config.HostConfig?.Privileged || false;
    
    const readonlyRootfsEl = document.getElementById('duplicate-readonly-rootfs');
    if (readonlyRootfsEl) readonlyRootfsEl.checked = config.HostConfig?.ReadonlyRootfs || false;
    
    // Capabilities
    if (config.HostConfig?.CapAdd && Array.isArray(config.HostConfig.CapAdd)) {
        config.HostConfig.CapAdd.forEach(cap => {
            addDuplicateCapability();
            const container = document.getElementById('duplicate-capabilities-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = cap;
        });
    }
    
    // Security options
    if (config.HostConfig?.SecurityOpt && Array.isArray(config.HostConfig.SecurityOpt)) {
        config.HostConfig.SecurityOpt.forEach(opt => {
            addDuplicateSecurityOpt();
            const container = document.getElementById('duplicate-security-opts-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = opt;
        });
    }
    
    // Runtime
    const restartPolicyEl = document.getElementById('duplicate-restart-policy');
    if (restartPolicyEl && config.HostConfig?.RestartPolicy) {
        restartPolicyEl.value = config.HostConfig.RestartPolicy.Name || 'no';
        const restartMaxRetriesEl = document.getElementById('duplicate-restart-max-retries');
        if (restartMaxRetriesEl && config.HostConfig.RestartPolicy.MaximumRetryCount) {
            restartMaxRetriesEl.value = config.HostConfig.RestartPolicy.MaximumRetryCount;
        }
    }
    
    const autoRemoveEl = document.getElementById('duplicate-auto-remove');
    if (autoRemoveEl) autoRemoveEl.checked = config.HostConfig?.AutoRemove || false;
    
    const ttyEl = document.getElementById('duplicate-tty');
    if (ttyEl) ttyEl.checked = config.Config?.Tty || false;
    
    const stdinOpenEl = document.getElementById('duplicate-stdin-open');
    if (stdinOpenEl) stdinOpenEl.checked = config.Config?.OpenStdin || false;
    
    const detachEl = document.getElementById('duplicate-detach');
    if (detachEl) detachEl.checked = config.Config?.AttachStdin === false;
    
    const initEl = document.getElementById('duplicate-init');
    if (initEl) initEl.checked = config.HostConfig?.Init || false;
    
    // Health check
    if (config.Config?.Healthcheck) {
        const healthCmdEl = document.getElementById('duplicate-health-cmd');
        if (healthCmdEl && config.Config.Healthcheck.Test) {
            const test = config.Config.Healthcheck.Test;
            if (Array.isArray(test)) {
                healthCmdEl.value = test.join(' ');
            } else {
                healthCmdEl.value = test;
            }
        }
        const healthIntervalEl = document.getElementById('duplicate-health-interval');
        if (healthIntervalEl && config.Config.Healthcheck.Interval) {
            healthIntervalEl.value = Math.round(config.Config.Healthcheck.Interval / 1000000000);
        }
        const healthTimeoutEl = document.getElementById('duplicate-health-timeout');
        if (healthTimeoutEl && config.Config.Healthcheck.Timeout) {
            healthTimeoutEl.value = Math.round(config.Config.Healthcheck.Timeout / 1000000000);
        }
        const healthRetriesEl = document.getElementById('duplicate-health-retries');
        if (healthRetriesEl && config.Config.Healthcheck.Retries) {
            healthRetriesEl.value = config.Config.Healthcheck.Retries;
        }
        const healthStartPeriodEl = document.getElementById('duplicate-health-start-period');
        if (healthStartPeriodEl && config.Config.Healthcheck.StartPeriod) {
            healthStartPeriodEl.value = Math.round(config.Config.Healthcheck.StartPeriod / 1000000000);
        }
    }
    
    // Logging
    if (config.HostConfig?.LogConfig) {
        const logDriverEl = document.getElementById('duplicate-log-driver');
        if (logDriverEl) logDriverEl.value = config.HostConfig.LogConfig.Type || '';
        
        if (config.HostConfig.LogConfig.Config && typeof config.HostConfig.LogConfig.Config === 'object') {
            Object.entries(config.HostConfig.LogConfig.Config).forEach(([key, value]) => {
                addDuplicateLogOpt();
                const container = document.getElementById('duplicate-log-opts-container');
                const items = container.querySelectorAll('.array-item');
                const lastItem = items[items.length - 1];
                if (lastItem) {
                    const keyInput = lastItem.querySelector('[data-logopt-key]');
                    const valueInput = lastItem.querySelector('[data-logopt-value]');
                    if (keyInput) keyInput.value = key;
                    if (valueInput) valueInput.value = value || '';
                }
            });
        }
    }
    
    // Advanced
    if (config.HostConfig?.Sysctls && typeof config.HostConfig.Sysctls === 'object') {
        Object.entries(config.HostConfig.Sysctls).forEach(([key, value]) => {
            addDuplicateSysctl();
            const container = document.getElementById('duplicate-sysctls-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = `${key}=${value}`;
        });
    }
    
    if (config.HostConfig?.Ulimits && Array.isArray(config.HostConfig.Ulimits)) {
        config.HostConfig.Ulimits.forEach(ulimit => {
            const ulimitStr = `${ulimit.Name}=${ulimit.Soft || ''}:${ulimit.Hard || ''}`;
            addDuplicateUlimit();
            const container = document.getElementById('duplicate-ulimits-container');
            const lastInput = container?.lastElementChild?.querySelector('input');
            if (lastInput) lastInput.value = ulimitStr;
        });
    }
    
    const oomKillDisableEl = document.getElementById('duplicate-oom-kill-disable');
    if (oomKillDisableEl) oomKillDisableEl.checked = config.HostConfig?.OomKillDisable || false;
    
    const pidsLimitEl = document.getElementById('duplicate-pids-limit');
    if (pidsLimitEl && config.HostConfig?.PidsLimit !== undefined) {
        pidsLimitEl.value = config.HostConfig.PidsLimit === 0 ? -1 : config.HostConfig.PidsLimit;
    }
    
    const shmSizeEl = document.getElementById('duplicate-shm-size');
    if (shmSizeEl && config.HostConfig?.ShmSize) {
        shmSizeEl.value = Math.round(config.HostConfig.ShmSize / (1024 * 1024));
    }
}

// Expose form functions to window for use in deploy view
window.collectFormData = collectFormData;
window.validateFormData = validateFormData;
window.deployDockerContainer = deployDockerContainer;

// Export required functions
export { fetchTemplates, displayTemplateList, openDeployModal, collectDuplicateFormData, populateDuplicateForm };
