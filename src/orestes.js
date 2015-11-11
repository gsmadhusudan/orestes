var Promise = require('bluebird');
var fse = Promise.promisifyAll(require('fs-extra'));
var express = require('express');
var body_parser = require('body-parser');
var retry = require('bluebird-retry');
var CassandraClient = require('./cassandra').client;
var CassandraErrors = require('./cassandra').errors;
var Elasticsearch = require('./elasticsearch');
var Query = require('./orestes-query');
var Delete = require('./orestes-remover');
var Insert = require('./orestes-inserter');
var utils = require('./orestes-utils');
var logger = require('logger').get('orestes');
var Bubo = require('./bubo');

var cassandra_client;
var SUCCESS = 200;

function _connect_to_cassandra(config) {
    var cass_params = {
        address: config.cassandra.host,
        port: config.cassandra.native_transport_port
    };

    return retry(function() {
        return cassandra_client.connect(cass_params)
        .catch(function(err) {
            logger.info('waiting for cassandra to start...', {message: err.message});
            throw err;
        });
    }, { max_tries: Infinity });
}

function _connect_to_elasticsearch(config) {
    var elasticsearch = new Elasticsearch(config);
    return elasticsearch.startup();
}

function startup(config) {
    cassandra_client = new CassandraClient(config.cassandra);

    return Promise.all([
        _connect_to_cassandra(config),
        _connect_to_elasticsearch(config)
    ])
    .then(function() {
        var bubo_cache = new Bubo(utils.buboOptions);

        Query.init(config);
        Delete.init(config, cassandra_client);
        Insert.init(config, bubo_cache, cassandra_client);
        utils.init(config, cassandra_client, bubo_cache);
        return _init_routes(config);
    });
}

function _init_routes(config) {
    var app = express();
    app.post('/write/:space*?', body_parser.json(), function write(req, res, next) {
        var points = req.body;
        var space = req.params.space || 'default';
        var want_result_details = req.headers['x-want-result-details'];

        return Insert.insert(points, space, want_result_details)
            .then(function(result) {
                res.json(result);
            });
    });

    app.post('/read/:space*?', body_parser.json(), function read(req, res, next) {
        var space = req.params.space || 'default';
        var es_filter = req.body.query;
        var from = req.body.start;
        var to = req.body.end;

        res.write('[');
        var first = true;
        function process_series(series) {
            if (first) {
                first = false;
            } else {
                res.write(',');
            }
            res.write(JSON.stringify(series));
        }

        return Query.read(es_filter, space, from, to, process_series)
            .then(function() {
                res.end(']');
            });
    });

    app.post('/delete/', body_parser.json(), function delete_data(req, res, next) {
        return Delete.remove(req.body)
            .then(function() {
                res.sendStatus(SUCCESS);
            });
    });

    return new Promise(function(resolve, reject) {
        app.listen(config.port, function() {
            console.log('Orestes is online!');
            resolve();
        });
    });
}

if (process.env.MAIN || require.main === module) {
    fse.readJsonAsync(__dirname + '/../conf/orestes-config.json')
        .then(function(conf) {
            return startup(conf);
        });
}

module.exports = {
    startup: startup,
    remove: Delete.remove,

    count_points: Query.count_points,
    get_metric_streams: Query.get_metric_streams,
    get_stream_list: Query.get_stream_list,
    get_stream_list_opt: Query.get_stream_list_opt
};
