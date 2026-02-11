/**
 * Build an ordered feature vector for ML services using the provided parameter ids.
 * Values are coerced with Number() to keep CSV parsing consistent and always
 * return a numeric array aligned to the requested parameter order.
 *
 * @param {Record<string, unknown>} row Normalized FDR row keyed by parameter id.
 * @param {string[]} selectedParamIds Ordered parameter ids to project into a vector.
 * @returns {number[]} Numeric vector; NaN is used when a value is missing.
 */
export function mapRowToFeatureVector(row, selectedParamIds = []) {
    return (Array.isArray(selectedParamIds) ? selectedParamIds : []).map((paramId) => {
        const value = row?.[paramId];
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : Number.NaN;
    });
}

export default mapRowToFeatureVector;