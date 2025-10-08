require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION - Load from config file and environment
// ============================================================================

// Load configuration from config.json
let config = {};
const configPath = path.join(__dirname, 'config.json');

try {
    if (fs.existsSync(configPath)) {
        const configFile = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configFile);
    } else {
        console.error('❌ config.json file not found!');
        console.error('📖 Please create config.json from config.example.json');
        process.exit(1);
    }
} catch (error) {
    console.error('❌ Error loading config.json:', error.message);
    process.exit(1);
}

// ProofHub Configuration (from config.json)
const PROOFHUB_API_URL = config.proofhub?.apiUrl || 'https://api.proofhub.com';
const PROJECT_ID = config.proofhub?.projectId;
const TODO_LIST_ID = config.proofhub?.todoListId;
const STAGE_CONFIG = config.stages || {};
const STAGE_HIERARCHY = config.stageHierarchy || {};
const PARENT_RULES_ENABLED = config.features?.parentRulesEnabled !== false;

// GitHub/Environment Configuration (from environment variables)
const PROOFHUB_API_KEY = process.env.PROOFHUB_API_KEY;
const TARGET_BRANCH = process.env.TARGET_BRANCH;
const PR_BODY = process.env.PR_BODY || '';
const PR_NUMBER = process.env.PR_NUMBER;

// ============================================================================
// VALIDATION
// ============================================================================

function validateConfiguration() {
    const errors = [];

    // Validate environment variables
    if (!PROOFHUB_API_KEY) errors.push('PROOFHUB_API_KEY environment variable is required');
    if (!TARGET_BRANCH) errors.push('TARGET_BRANCH environment variable is required');

    // Validate config.json values
    if (!PROJECT_ID) errors.push('proofhub.projectId is required in config.json');
    if (!TODO_LIST_ID) errors.push('proofhub.todoListId is required in config.json');
    if (Object.keys(STAGE_CONFIG).length === 0) errors.push('stages configuration is required in config.json');

    if (errors.length > 0) {
        console.error('❌ Configuration Error:');
        errors.forEach(err => console.error(`   - ${err}`));
        console.error('\n📖 Please check the documentation for required configuration.');
        process.exit(1);
    }
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

// Extract added task IDs from ProofHub section in PR body
function extractTaskIds(prBody) {
    const taskIds = [];
    const sectionPattern = /### 📋 ProofHub Tasks([\s\S]*?)(?:\n---|$)/i;
    const sectionMatch = sectionPattern.exec(prBody);
    if (!sectionMatch) return [];

    const sectionContent = sectionMatch[1];
    const taskPattern = /#(\d{9,})/g;

    let match;
    while ((match = taskPattern.exec(sectionContent)) !== null) {
        taskIds.push(match[1]);
    }

    return [...new Set(taskIds)];
}

// Get task details from ProofHub
async function getTaskDetails(taskId) {
    try {
        const taskUrl = `${PROOFHUB_API_URL}/api/v3/projects/${PROJECT_ID}/todolists/${TODO_LIST_ID}/tasks/${taskId}`;
        const response = await axios.get(taskUrl, {
            headers: {
                "X-API-Key": PROOFHUB_API_KEY,
                "User-Agent": "Github Actions"
            }
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Failed to fetch task #${taskId}:`, error.response?.data || error.message);
        return null;
    }
}

// Get all subtasks for a parent task
async function getSubtasks(parentId) {
    try {
        const listUrl = `${PROOFHUB_API_URL}/api/v3/projects/${PROJECT_ID}/todolists/${TODO_LIST_ID}/tasks`;
        const response = await axios.get(listUrl, {
            headers: {
                "X-API-Key": PROOFHUB_API_KEY,
                "User-Agent": "Github Actions"
            }
        });

        // Filter tasks that have the specified parent_id
        const subtasks = response.data.filter(task => task.parent_id === parseInt(parentId));
        return subtasks;
    } catch (error) {
        console.error(`❌ Failed to fetch subtasks for parent #${parentId}:`, error.response?.data || error.message);
        return [];
    }
}

// Update task stage in ProofHub
async function updateTaskStage(taskId, targetStageId, targetStageName, reason = '') {
    try {
        const taskUrl = `${PROOFHUB_API_URL}/api/v3/projects/${PROJECT_ID}/todolists/${TODO_LIST_ID}/tasks/${taskId}`;

        await axios.put(taskUrl, {
            stage: targetStageId
        }, {
            headers: {
                "X-API-Key": PROOFHUB_API_KEY,
                "User-Agent": "Github Actions",
                "Content-Type": "application/json"
            }
        });

        console.log(`✅ Task #${taskId} → "${targetStageName}"${reason ? ` (${reason})` : ''}`);
        return { success: true, taskId };

    } catch (error) {
        console.error(`❌ Failed to update task #${taskId}:`, error.response?.data || error.message);
        return { success: false, taskId, error: error.message };
    }
}

// Helper function to find stage ID by name
function findStageIdByName(stageName) {
    for (const branch in STAGE_CONFIG) {
        if (STAGE_CONFIG[branch].targetStage === stageName) {
            return STAGE_CONFIG[branch].targetStageId;
        }
    }
    return null;
}

// Determine parent stage based on subtasks
function determineParentStage(parentCurrentStage, subtasks) {
    const subtaskStages = subtasks.map(st => st.stage?.name || 'Unknown');

    // Get parent rules from config
    const parentRules = config.parentRules || [];

    for (const rule of parentRules) {
        // Check if current parent stage matches rule condition
        if (rule.parentStage !== parentCurrentStage) continue;

        // Check each action in the rule
        for (const action of rule.actions) {
            const matchingSubtasks = subtaskStages.filter(s => s === action.subtaskStage).length;

            // Check if condition is met
            if (action.condition === 'all' && matchingSubtasks === subtasks.length) {
                return {
                    stage: action.moveParentTo,
                    stageId: findStageIdByName(action.moveParentTo),
                    reason: `All subtasks in ${action.subtaskStage}`
                };
            } else if (action.condition === 'some' && matchingSubtasks > 0) {
                return {
                    stage: action.moveParentTo,
                    stageId: findStageIdByName(action.moveParentTo),
                    reason: `Some subtasks in ${action.subtaskStage}`
                };
            }
        }
    }

    return null;
}

// Check if stage movement is forward only
function isForwardMovement(currentStage, targetStage) {
    if (Object.keys(STAGE_HIERARCHY).length === 0) {
        return true; // If no hierarchy defined, allow all movements
    }

    const currentLevel = STAGE_HIERARCHY[currentStage] || 0;
    const targetLevel = STAGE_HIERARCHY[targetStage] || 0;
    return targetLevel >= currentLevel;
}

// Process a single task and return parent ID if exists
async function processTask(taskId, branchConfig) {
    try {
        const task = await getTaskDetails(taskId);
        if (!task) {
            return { success: false, taskId, parentId: null };
        }

        const currentStage = task.stage?.name || 'Unknown';

        // Update the task itself
        if (currentStage !== branchConfig.targetStage) {
            await updateTaskStage(taskId, branchConfig.targetStageId, branchConfig.targetStage, 'Direct update from PR');
        } else {
            console.log(`ℹ️ Task #${taskId} already in "${branchConfig.targetStage}"`);
        }

        return { success: true, taskId, parentId: task.parent_id };

    } catch (error) {
        console.error(`❌ Failed to process task #${taskId}:`, error.message);
        return { success: false, taskId, parentId: null, error: error.message };
    }
}

// Process parent task based on subtask rules
async function processParentTask(parentId) {
    try {
        console.log(`\n🔍 Processing parent task #${parentId}...`);

        const parentTask = await getTaskDetails(parentId);
        if (!parentTask) {
            console.log(`❌ Could not fetch parent task #${parentId}`);
            return { success: false, parentId };
        }

        const parentCurrentStage = parentTask.stage?.name || 'Unknown';
        console.log(`   Parent current stage: ${parentCurrentStage}`);

        const subtasks = await getSubtasks(parentId);
        if (subtasks.length === 0) {
            console.log(`   ℹ️ No subtasks found for parent #${parentId}`);
            return { success: true, parentId };
        }

        console.log(`   Found ${subtasks.length} subtask(s)`);
        subtasks.forEach(st => {
            console.log(`      - Subtask #${st.id}: ${st.stage?.name || 'Unknown'}`);
        });

        const newStageInfo = determineParentStage(parentCurrentStage, subtasks);

        if (newStageInfo && newStageInfo.stageId) {
            // Validate forward-only movement
            if (!isForwardMovement(parentCurrentStage, newStageInfo.stage)) {
                console.log(`   ⚠️ Cannot move parent backwards: ${parentCurrentStage} → ${newStageInfo.stage}`);
                return { success: true, parentId, skipped: true };
            }

            if (parentCurrentStage !== newStageInfo.stage) {
                await updateTaskStage(parentId, newStageInfo.stageId, newStageInfo.stage, newStageInfo.reason);
                return { success: true, parentId, updated: true };
            } else {
                console.log(`   ℹ️ Parent already in target stage: ${newStageInfo.stage}`);
            }
        } else {
            console.log(`   ℹ️ No stage change needed for parent`);
        }

        return { success: true, parentId };

    } catch (error) {
        console.error(`❌ Failed to process parent #${parentId}:`, error.message);
        return { success: false, parentId, error: error.message };
    }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

(async () => {
    console.log('🚀 ProofHub Task Automation Script\n');

    // Validate configuration
    validateConfiguration();

    const branchConfig = STAGE_CONFIG[TARGET_BRANCH];
    if (!branchConfig) {
        console.log(`ℹ️ No task automation configured for branch: ${TARGET_BRANCH}`);
        process.exit(0);
    }

    console.log(`📌 Target Branch: ${TARGET_BRANCH}`);
    console.log(`🎯 Target Stage: ${branchConfig.targetStage}`);
    console.log(`🆔 PR Number: #${PR_NUMBER}\n`);

    const addedTaskIds = extractTaskIds(PR_BODY);
    if (addedTaskIds.length === 0) {
        console.log('ℹ️ No tasks were added in the PR. No updates performed.');
        process.exit(0);
    }

    console.log(`📋 Found ${addedTaskIds.length} added task(s): ${addedTaskIds.join(', ')}\n`);

    // Step 1: Process all added tasks and collect parent IDs
    const parentIds = new Set();
    const taskResults = [];

    for (const taskId of addedTaskIds) {
        const result = await processTask(taskId, branchConfig);
        taskResults.push(result);

        if (result.parentId && PARENT_RULES_ENABLED) {
            parentIds.add(result.parentId);
        }
    }

    // Step 2: Process all parent tasks (if enabled)
    const parentResults = [];
    if (PARENT_RULES_ENABLED && parentIds.size > 0) {
        console.log(`\n👨‍👩‍👧‍👦 Processing ${parentIds.size} parent task(s)...`);

        for (const parentId of parentIds) {
            const result = await processParentTask(parentId);
            parentResults.push(result);
        }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 EXECUTION SUMMARY');
    console.log('='.repeat(60));

    const successfulTasks = taskResults.filter(r => r.success).length;
    const failedTasks = taskResults.filter(r => !r.success).length;
    console.log(`✅ Tasks updated: ${successfulTasks}/${addedTaskIds.length}`);
    if (failedTasks > 0) console.log(`❌ Tasks failed: ${failedTasks}`);

    if (PARENT_RULES_ENABLED && parentIds.size > 0) {
        const successfulParents = parentResults.filter(r => r.success && r.updated).length;
        const skippedParents = parentResults.filter(r => r.success && r.skipped).length;
        const failedParents = parentResults.filter(r => !r.success).length;

        console.log(`👨‍👩‍👧‍👦 Parent tasks updated: ${successfulParents}/${parentIds.size}`);
        if (skippedParents > 0) console.log(`⚠️  Parent tasks skipped (backward movement): ${skippedParents}`);
        if (failedParents > 0) console.log(`❌ Parent tasks failed: ${failedParents}`);
    }

    console.log('='.repeat(60));

    process.exit(failedTasks > 0 ? 1 : 0);
})();