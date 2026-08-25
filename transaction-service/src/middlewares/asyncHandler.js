/**
 * Envuelve un controller async para que sus rechazos lleguen a next(err) en
 * vez de tener que repetir un try/catch en cada endpoint.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
