const { Playbook, PlaybookVersion } = require("@girp/database-models");
const createError = require("http-errors");

exports.getPlaybookStatus = async (req, res) => {
    const { id } = req.params;

    // Playbooks are addressed by their public playbookId, not the Mongo _id.
    // deletedAt: null — a playbook in the SOCView trash must not be served anymore.
    const playbook = await Playbook.findOne({ playbookId: id, deletedAt: null }).select("status");

    if (!playbook) {
        throw createError(404, "Playbook not found");
    }

    res.json({
        status: playbook.status
    });
};

exports.getPlaybook = async (req, res) => {
    const { id } = req.params;

    // deletedAt: null — a playbook in the SOCView trash must not be served anymore.
    const playbook = await Playbook.findOne({ playbookId: id, deletedAt: null }).select("status");
    if (!playbook) {
        throw createError(404, "Playbook not found");
    }

    if (playbook.status !== "active") {
        throw createError(403, "This playbook is disabled");
    }

    const versionData = await PlaybookVersion.findOne({ playbookId: id }).sort({ version: -1 }).lean();
    if (!versionData || !versionData.definition) {
        throw createError(404, "Playbook definition not found");
    }

    res.json({
        status: playbook.status,
        definition: versionData.definition,
        playbookId: versionData.playbookId,
        playbookVersion: versionData.version
    });
};
