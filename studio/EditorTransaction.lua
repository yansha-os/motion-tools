local EditorTransaction = {}

function EditorTransaction.run(apply, rollback)
    local applied, result = pcall(apply)
    if applied then return true, result, true end

    local restored, restoreError = pcall(rollback)
    return false, result, restored, restoreError
end

return EditorTransaction
