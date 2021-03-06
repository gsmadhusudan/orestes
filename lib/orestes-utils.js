var _ = require('underscore');
var Promise = require('bluebird');
var OrestesSettings = require('./orestes-settings');
var cassUtils = require('./cassandra').utils;
var metricsTableName = OrestesSettings.TABLE_NAME;
var keyspacePrefix = OrestesSettings.KEYSPACE_PREFIX;
var msInDay = 1000 * 60 * 60 * 24;
var bubo;
var logger = require('../logger').get('orestes');

var prepareds = {};
var orestesTableConfig, space_info;

var preparedBases = {
    select: 'SELECT offset, value FROM %s.%s WHERE attrs = ? AND offset >= ? AND offset < ?;',
    count: 'SELECT COUNT(*) FROM %s.%s WHERE attrs = ? AND offset >= ? AND offset < ?;',
    import: 'INSERT INTO %s.%s (attrs, offset, value) VALUES (?, ?, ?);'
};

var table_options = {
    compact_storage: true,
    bloom_filter_fp_chance: 0.010000,
    comment: '',
    dclocal_read_repair_chance: 0.000000,
    gc_grace_seconds: 864000,
    read_repair_chance: 1.000000,
    default_time_to_live: 0,
    speculative_retry: 'NONE',
    memtable_flush_period_in_ms: 0,
    compaction: {class: 'SizeTieredCompactionStrategy'},
    compression: {sstable_compression: 'LZ4Compressor'}
};

function init(config, cassandraClient, bubo_cache) {
    bubo = bubo_cache;
    space_info = config.spaces;

    cassUtils.init(cassandraClient, prepareds);

    var tableOptions = cassUtils.buildOptsString(table_options);
    logger.info('table options string', tableOptions);

    orestesTableConfig = {
        table_fields: OrestesSettings.table_fields,
        primary_key: OrestesSettings.primary_key,
        table_options: tableOptions
    };
}
// rounds n to the nearest multiple of our metadata granularity
function roundToGranularity(n, space) {
    var granularity = space_info[space].table_granularity_days;
    return Math.floor(n / granularity) * granularity;
}

function spaceFromIndex(_index) {
    return _index.substring(_index.indexOf('-') + 1, _index.indexOf('@'));
}

function dayFromIndex(_index) {
    return parseInt(_index.substring(_index.indexOf('@') + 1));
}

function orestesKeyspaceName(space) {
    return '"' + keyspacePrefix + space + '"';
}

function orestesTableName(day) {
    return metricsTableName + day;
}

function getOrestesPrepared(space, day, type) {
    var preparedOptions = _.extend({
        keyspace: orestesKeyspaceName(space),
        columnfamily: orestesTableName(day),
        cql: preparedBases[type]
    }, orestesTableConfig);

    return cassUtils.getPrepared(preparedOptions);
}

function normalize_timestamp(ts) {
    ts = new Date(ts).getTime();
    if (typeof ts !== 'number' || ts !== ts) { // speedy hack for isNaN(ts)
        throw new Error('invalid timestamp');
    }

    return ts;
}

function getImportPrepareds(space, points) {
    var days = {};
    points.forEach(function(pt) {
        try {
            pt.time = normalize_timestamp(pt.time);
        } catch (err) {
            // catch it later
            return;
        }

        var day = roundToGranularity(Math.floor(pt.time / msInDay), space);
        if (!days[day]) {
            days[day] = 1;
        }
    });

    days = _.keys(days);
    return Promise.map(days, function(day) {
        return getOrestesPrepared(space, day, 'import');
    })
    .then(function(prepped) {
        var ret = {};
        days.forEach(function(day, i) {
            ret[day] = prepped[i];
        });
        return ret;
    });
}

function dayFromOrestesTable(table) {
    var numStart = table.indexOf(metricsTableName) + metricsTableName.length;
    return Number(table.substring(numStart));
}

function metadataIndexName(space, day) {
    return 'metadata-' + space + '@' + day;
}

function clearOrestesPrepareds(space, deleteDay) {
    var keyspace = orestesKeyspaceName(space);
    _.each(prepareds[keyspace], function(prepped, cfName) {
        if (dayFromOrestesTable(cfName) <= deleteDay) {
            prepareds[keyspace][cfName] = null;
        }
    });
}

// to be called on delete, blows away our cached information
// for deleted tables
function clearCaches(space, deleteDay) {
    clearOrestesPrepareds(space, deleteDay);
    var buckets = bubo.get_buckets();
    buckets.forEach(function(bucket) {
        if (spaceFromIndex(bucket) === space && dayFromIndex(bucket) <= deleteDay) {
            bubo.delete_bucket(bucket);
        }
    });
}

function weekFromTable(table) {
    return Number(table.substring(metricsTableName.length));
}

var defaultUnwantedTags = ['time', 'value'];

// this is inaesthetic but Object.keys() is not cheap so we
// combine the logically distinct operations that iterate
// over the keys of the point for performance
function getValidatedStringifiedPoint(pt, attrs) {
    if (!pt.hasOwnProperty('time') || !pt.hasOwnProperty('value')) {
        cassUtils.validateHasAll(pt, ['time', 'value']);
    }
    if (attrs.length === 0) {
        throw new Error('metrics must have at least one tag');
    }
    pt.time = normalize_timestamp(pt.time);
    // the second argument to JSON.stringify is a whitelist of keys to stringify
    return JSON.stringify(pt, Object.keys(pt).filter(function(key) {
        var value = pt[key];
        if (key === 'value') {
            if (typeof value !== 'number' || value !== value) { // speedy hack for isNaN(value)
                throw new Error('invalid value ' + value);
            }
        } else {
            // disallow any points with nested structure (typeof null === 'object' so we check truthiness too)
            if (value && typeof value === 'object') {
                throw new Error('invalid tag - value is an object or array ' + key + ' : ' + value);
            }
        }

        return key !== 'time' && key !== 'value';
    }));
}

function getAllTablesForSpace(space) {
    var keyspace = orestesKeyspaceName(space);
    return cassUtils.getAllTablesForKeyspace(keyspace);
}

module.exports = {
    init: init,
    roundToGranularity: roundToGranularity,
    spaceFromIndex: spaceFromIndex,
    dayFromIndex: dayFromIndex,
    getPrepared: getOrestesPrepared,
    getImportPrepareds: getImportPrepareds,
    dayFromOrestesTable: dayFromOrestesTable,
    metadataIndexName: metadataIndexName,
    weekFromTable: weekFromTable,
    orestesKeyspaceName: orestesKeyspaceName,
    clearCaches: clearCaches,
    getAllTablesForSpace: getAllTablesForSpace,
    getValidatedStringifiedPoint: getValidatedStringifiedPoint,
    buboOptions: {
        ignoredAttributes: defaultUnwantedTags
    }
};
