exports.cmp = 'value';
exports.run = function(tr, cb) {
  tr.locate('locator', cb, function(err, element) {
    tr.do('getComputedCSS', [element, tr.p('propertyName')], cb, function(err, value) {
      cb({'value': value});
    });
  });
};
