/**
 * Structured FDR parameter configuration used by selectors and charts.
 * Each category groups related parameters by the recorder column id so UI and
 * data parsing stay in sync. Extend this list to add new chart overlays without
 * touching rendering code.
 *
 * @typedef {Object} FdrParameter
 * @property {string} id   CSV column name used in the uploaded file.
 * @property {string} label Display name for the UI.
 * @property {string} [unit] Optional unit label (ft, knots, deg, etc.).
 *
 * @typedef {Object} FdrParameterCategory
 * @property {string} name  Human-readable category title.
 * @property {string} key   Stable machine key for lookups and styling.
 * @property {FdrParameter[]} params Ordered list of parameters in the category.
 */

/** @type {FdrParameterCategory[]} */
export const fdrParameterConfig = [
    {
        name: "Engines",
        key: "engines",
        params: [
            { id: "RPM L", label: "RPM Left", unit: "rpm" },
            { id: "RPM R", label: "RPM Right", unit: "rpm" },
        ],
    },
    {
        name: "Fuel",
        key: "fuel",
        params: [{ id: "Fuel Flow 1 (gal/hr)", label: "Fuel Flow 1", unit: "gal/hr" }],
    },
    {
        name: "Environment",
        key: "environment",
        params: [{ id: "OAT (deg C)", label: "Outside Air Temperature", unit: "°C" }],
    },
    {
        name: "Flight Dynamics – Energy / Kinematics",
        key: "flight-dynamics-energy",
        params: [
            { id: "GPS Altitude (feet)", label: "GPS Altitude", unit: "ft" },
            { id: "Pressure Altitude (ft)", label: "Pressure Altitude", unit: "ft" },
            { id: "Indicated Airspeed (knots)", label: "Indicated Airspeed", unit: "knots" },
            { id: "Ground Speed (knots)", label: "Ground Speed", unit: "knots" },
            { id: "True Airspeed (knots)", label: "True Airspeed", unit: "knots" },
            { id: "Vertical Speed (ft/min)", label: "Vertical Speed", unit: "ft/min" },
        ],
    },
    {
        name: "Flight Dynamics – Attitude",
        key: "flight-dynamics-attitude",
        params: [
            { id: "Pitch (deg)", label: "Pitch", unit: "deg" },
            { id: "Roll (deg)", label: "Roll", unit: "deg" },
            { id: "Magnetic Heading (deg)", label: "Magnetic Heading", unit: "deg" },
        ],
    },
    {
        name: "Navigation",
        key: "navigation",
        params: [
            { id: "Latitude (deg)", label: "Latitude", unit: "deg" },
            { id: "Longitude (deg)", label: "Longitude", unit: "deg" },
        ],
    },
];

/**
 * Flattened helper for quick metadata lookups in charts and selectors.
 */
export const fdrParameterMap = fdrParameterConfig.flatMap((category) =>
    category.params.map((param) => ({
        ...param,
        categoryName: category.name,
        categoryKey: category.key,
    }))
);

export default fdrParameterConfig;